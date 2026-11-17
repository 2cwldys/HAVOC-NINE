#include "plugin.h"
#include <string.h>
#ifdef _WIN32
#include <string.h>
#else
#include <strings.h>
#endif
#include <stdlib.h>
#include <stdio.h>
#include <math.h>

// ======================================================================================
// EntMod4 -- entity mover tool (entmover.cpp). The EntMover* helpers drive the custom
// "mover weapon" (grab / drag / release an entity); DFEntMover is the entmover_* console
// command parser dispatched from DFClientCommand.
//
// NOTE (contract gap): the original stores all per-player editing state in the full
// EntInfo3 block (0xfd30 bytes/player). The reconstructed plugin.h playerstate_t exposes
// only adminflags, and the contract is frozen, so the grab/rotate/multi-grab editing
// state, the undo ring and the entity-save tables are held in the file-local shadow
// below. State shared across modules (undo ring, entity-save table, the targetname save
// table at VA 0x8f260) cannot be wired module-locally under the frozen contract; the
// commands that need it are stubbed (see incomplete[]).
// ======================================================================================

static char s_msg[1024];
static int  s_explode = 0;   // sprites/zerogxplode.spr index (dispatch.cpp owns the real one)

struct MoverGrabSlot                 // one multi-grab entry (binary stride 0x30)
{
	int    entindex;
	int    pad;
	Vector origin;
	int    rendermode;
	float  renderamt;
	int    renderfx;
	Vector rendercolor;
	int    movetype;
};

struct MoverState
{
	int    grabEnt;              // +0x24  held entity index (grabtype/+rotate)
	int    copyEnt;              // +0x28  copy-hold entity index
	int    mmActive;            // +0x2c  multi-grab in progress
	int    esActive;            // +0x30  entity-save selection in progress
	int    holdMode;            // +0x80  0 none, 1 grab, 2 rotate
	Vector playerGrabOrigin;    // +0x90
	Vector entGrabOrigin;       // +0x84
	int    savedRendermode;     // +0x9c
	float  savedRenderamt;      // +0xa0
	int    savedRenderfx;       // +0xa4
	Vector savedRendercolor;    // +0xa8
	int    savedMovetype;       // +0xb4
	int    savedEffects;        // +0xb8
	Vector savedAngles;         // +0xbc
	int    mmCount;             // +0x1c
	Vector mmInfoOrigin;        // +0x74
	MoverGrabSlot mm[128];      // +0x22c54c
	// weapon grab-move undo snapshot (EntMoverAttack writes, EntMoverOff reads)
	edict_t *mgEnt;             // +0xcce8
	int    mgActive;            // +0xcccc
	Vector mgStart;             // +0xccd0
	Vector mgEnd;               // +0xccdc
	// train-path editor (t_select / t_start / t_end / t_go)
	int    tSelected;           // +0x00  a train is selected
	int    tTrainIndex;         // +0x04  selected / spawned train entity index
	char   tBaseName[9];        // +0x08  path base name (<= 8 chars)
	int    tCounter;            // +0x14  path-corner counter / editing flag
	float  tLastDrop;           // +0x18  last corner-drop time
	// entity-save selection naming (es_start / es_save)
	char   esSaveName[0x30];    // +0x34  save-set base name
	char   esInfoFlag;          // +0x63  write-info flag, reset by es_start
	// weapon grab-undo name buffers (EntMoverAttack / +grabent write; read via the save table)
	char   grabKeytext[0x600];  // +0xccec
	char   grabClassname[0x40]; // +0xd2ec
};

static MoverState g_mv[ENT_MAXPLAYERS];

static inline int      EIDX(edict_t *e) { return g_engfuncs.pfnIndexOfEdict(e); }
static inline edict_t *EDICT(int i)     { return g_engfuncs.pfnPEntityOfEntIndex(i); }
static inline char    *NWslot(edict_t *p) { return NewWeapons + EIDX(p) * 0x48; }
static inline MoverState &MV(edict_t *p)  { return g_mv[EIDX(p)]; }

static inline void MB(int d, int t, const float *o, edict_t *e) { g_engfuncs.pfnMessageBegin(d, t, o, e); }
static inline void WB(int v)  { g_engfuncs.pfnWriteByte(v); }
static inline void WS(int v)  { g_engfuncs.pfnWriteShort(v); }
static inline void WC(float v){ g_engfuncs.pfnWriteCoord(v); }
static inline void ME()       { g_engfuncs.pfnMessageEnd(); }
static inline int  RL(int a, int b) { return g_engfuncs.pfnRandomLong(a, b); }

static inline int iround(float f) { return (int)(f + (f < 0.0f ? -0.5f : 0.5f)); }

// trace from the player eye straight ahead; returns the hit edict (tr filled)
static edict_t *MoverTraceForward(edict_t *player, IGNORE_MONSTERS ignmon, TraceResult *tr)
{
	entvars_t *pev = &player->v;
	UTIL_MakeVectors(pev->v_angle);
	Vector vecSrc = pev->origin + pev->view_ofs;
	Vector vecEnd = vecSrc + gpGlobals->v_forward * 10240.0f;
	UTIL_TraceLine(vecSrc, vecEnd, ignmon, player, tr);
	return tr->pHit;
}

// the custom hit/kill burst used by EntMoverSpecial, e_kill and es_grab
static void MoverKillEffect(edict_t *player, const Vector &pos)
{
	int pidx = EIDX(player);
	MB(0, 23, NULL, NULL); WB(1); WS(pidx);              // TE_BEAMENTPOINT
	WC(pos.x); WC(pos.y); WC(pos.z);
	WS(precached_models); WB(0); WB(0); WB(2); WB(5); WB(0x32);
	WB(RL(200, 0xff)); WB(RL(0, 0xf)); WB(RL(0, 0xf)); WB(0xff); WB(0x14); ME();
	MB(0, 23, NULL, NULL); WB(1); WS(pidx);
	WC(pos.x); WC(pos.y); WC(pos.z);
	WS(precached_models); WB(0); WB(0); WB(2); WB(5); WB(10);
	WB(RL(200, 0xff)); WB(RL(100, 0x92)); WB(RL(0x20, 0x60)); WB(0xff); WB(0x14); ME();
	Vector p = pos;
	MB(5, 23, &p.x, NULL); WB(3);                        // TE_EXPLOSION
	WC(pos.x); WC(pos.y); WC(pos.z);
	WS(s_explode); WB(10); WB(0x14); WB(0); ME();
}

// instakill via a "teledeath" trigger spawned at a far origin
static void MoverTeleDeath(edict_t *victim, float coord)
{
	edict_t *td = g_engfuncs.pfnCreateNamedEntity(MAKE_STRING("teledeath"));
	if (!td)
		return;
	td->v.spawnflags |= 0x40000000;
	td->v.origin = Vector(coord, coord, coord);
	m_DispatchSpawn(td);
	td->v.classname = MAKE_STRING("e_kill");
	m_DispatchTouch(td, victim);
}

// classname / keyvalue-text sub-fields of the es_ save table (one 0x640-byte slot per entity)
static inline char *EntClassname(int entidx) { return &Entities[entidx * 0x640]; }
static inline char *EntKeytext(int entidx)   { return &Entities[entidx * 0x640 + 0x40]; }

// the blue "selected" burst es_grab draws at the trace point (two TE_BEAMENTPOINT beams)
static void MoverSelectEffect(edict_t *player, const Vector &pos)
{
	int pidx = EIDX(player);
	MB(0, 23, NULL, NULL); WB(1); WS(pidx);
	WC(pos.x); WC(pos.y); WC(pos.z);
	WS(precached_models); WB(0); WB(0); WB(2); WB(5); WB(0x32);
	WB(RL(0, 0xf)); WB(RL(0, 0xf)); WB(RL(200, 0xff)); WB(0xff); WB(0x14); ME();
	MB(0, 23, NULL, NULL); WB(1); WS(pidx);
	WC(pos.x); WC(pos.y); WC(pos.z);
	WS(precached_models); WB(0); WB(0); WB(2); WB(5); WB(10);
	WB(RL(0x20, 0x60)); WB(RL(100, 0x92)); WB(RL(200, 0xff)); WB(0xff); WB(0x14); ME();
}

// push a movement undo (action 1) onto the shared per-player ring (admintools owns the ring +
// count; DFPrepareUndo rotates it when full). Used by -grabent and EntMoverOff.
static void PushMoveUndo(edict_t *player, edict_t *ent, const Vector &savedOrigin, const Vector &savedAngles)
{
	int idx  = EIDX(player);
	int slot = es_undoCount[idx];
	DFPrepareUndo(player);
	es_undo_t &u = es_undo[idx][slot];
	u.ent    = ent;
	u.action = 1;
	u.origin = savedOrigin;
	u.angles = savedAngles;
	int entidx = EIDX(ent);
	strncpy(u.text, EntKeytext(entidx), 0x600);       u.text[0x600 - 1] = 0;
	strncpy(u.classname, EntClassname(entidx), 0x40); u.classname[0x40 - 1] = 0;
	if (slot < 0x1f)
		es_undoCount[idx]++;
}

// visual fields e_stack / +copyent carry onto a freshly spawned clone (origin set by the caller)
static void CopyEntVisual(edict_t *dst, edict_t *src)
{
	for (int i = 0; i < 4; i++)
		dst->v.controller[i] = src->v.controller[i];
	dst->v.owner       = src->v.owner;
	dst->v.angles      = src->v.angles;
	dst->v.rendermode  = src->v.rendermode;
	dst->v.renderamt   = src->v.renderamt;
	dst->v.rendercolor = src->v.rendercolor;
	dst->v.renderfx    = src->v.renderfx;
}

// clone an entity: replay its saved "classname:keytext" through AddGameEntity, then carry the
// source's visual fields onto the new edict (the caller sets the final origin)
static edict_t *CloneEnt(edict_t *src)
{
	int ei = EIDX(src);
	char line[1024];
	snprintf(line, sizeof(line), "%s:%s", EntClassname(ei), EntKeytext(ei));
	edict_t *clone = AddGameEntity(line);
	if (clone)
		CopyEntVisual(clone, src);
	return clone;
}

// EntMoverDeploy @0x50fa0
void EntMoverDeploy(edict_t *player)
{
	entvars_t *pev = &player->v;
	*(int *)(NWslot(player) + 0x28) = 0;
	pev->weaponanim = 9;
	MB(1, 35, NULL, player);            // SVC_WEAPONANIM
	WB(9);
	WB(pev->body);
	ME();
	pev->viewmodel   = MAKE_STRING("addons/EntMod/models/v_phaser.mdl");
	pev->weaponmodel = MAKE_STRING("addons/EntMod/models/p_phaser.mdl");
}

// EntMoverDestroyEffect @0x51950
void EntMoverDestroyEffect(edict_t *player)
{
	char *nw = NWslot(player);
	edict_t *beam = *(edict_t **)(nw + 0x20);
	if (beam)
	{
		beam->v.flags |= 0x40000000;
		*(edict_t **)(nw + 0x20) = 0;
	}
}

// EntMoverCreateEffect @0x519b0
void EntMoverCreateEffect(edict_t *player)
{
	EntMoverDestroyEffect(player);
	char *nw = NWslot(player);
	edict_t *beam = BeamCreate("sprites/laserbeam.spr", 10);
	*(edict_t **)(nw + 0x20) = beam;
	entvars_t *bpev = beam ? &beam->v : NULL;
	PointEntInit(player->v.origin, EIDX(player), bpev);
	bpev->spawnflags |= 0x8000;
	bpev->owner       = player;
	bpev->rendermode  = (bpev->rendermode & 0x0f) | 0x20;
	bpev->animtime    = 25.0f;
	bpev->renderamt   = 100.0f;
	bpev->skin        = (bpev->skin & 0x0fff) | 0x1000;
	bpev->rendercolor = Vector((float)RL(0, 0xff), (float)RL(0, 0xff), (float)RL(0, 0xff));
	bpev->body        = 0;
}

// EntMoverUpdateEffect @0x51b00  (start is unused in the original; only end is applied)
void EntMoverUpdateEffect(const Vector &start, const Vector &end, edict_t *player)
{
	char *nw = NWslot(player);
	if (*(int *)(nw + 0x20) == 0)
		EntMoverCreateEffect(player);
	edict_t *beam = *(edict_t **)(nw + 0x20);
	entvars_t *bpev = beam ? &beam->v : NULL;
	bpev->origin = end;
	RelinkBeam(bpev);
}

// EntMoverPrecache @0x52100
void EntMoverPrecache(void)
{
	PRECACHE_MODEL("addons/EntMod/models/v_phaser.mdl");
	PRECACHE_MODEL("addons/EntMod/models/p_phaser.mdl");
	PRECACHE_SOUND("items/inv3.wav");
	s_explode = PRECACHE_MODEL("sprites/zerogxplode.spr");
}

// EntMoverAttack @0x51040  -- grab the entity under the crosshair (or the nearest moveable)
void EntMoverAttack(edict_t *player)
{
	entvars_t *pev = &player->v;
	UTIL_MakeVectors(pev->v_angle);
	Vector vecSrc = pev->origin + pev->view_ofs;
	Vector vecEnd = vecSrc + gpGlobals->v_forward * 10240.0f;
	TraceResult tr;
	UTIL_TraceLine(vecSrc, vecEnd, dont_ignore_monsters, player, &tr);
	edict_t *pEnt = tr.pHit;
	if (FStrEq(STRING(pEnt->v.classname), "worldspawn"))
	{
		pEnt = DFFindEntityForward(player, 96.0f, NULL, player, true, false);
		if (!pEnt)
			return;
		ClientPrint2(player, 3, UTIL_VarArgs("[%s] Grabbed %s Index: %i\n", "Ent Mod",
			STRING(pEnt->v.classname), EIDX(pEnt)));
	}
	EMIT_SOUND_DYN(player, 3, "items/inv3.wav", 1.0f, 0.8f, 0, 100);

	char *nw = NWslot(player);
	*(edict_t **)(nw + 0x28) = pEnt;
	*(Vector *)(nw + 0x3c) = tr.vecEndPos;
	*(Vector *)(nw + 0x30) = pEnt->v.origin;
	*(float *)(nw + 0x2c) = (tr.vecEndPos - vecSrc).Length();

	if (!FStrEq(STRING(pEnt->v.classname), "player"))
	{
		MoverState &m = MV(player);
		m.mgEnt    = pEnt;
		m.mgActive = 1;
		m.mgStart  = pEnt->v.origin;
		m.mgEnd    = pEnt->v.origin;
		// NOTE: the original also copies the entity's classname/targetname into the
		// per-player grab-undo name buffers (EntInfo3 +0x22bf0c/+0x22c50c); that save
		// table is admintools-owned and undeclared, so it is omitted here.
	}
	else
	{
		*(int *)(nw + 0x24) = pEnt->v.movetype;
		pEnt->v.movetype = 8;
	}
}

// EntMoverSpecial @0x51420  -- the alt-fire "destroy" (hit burst then kill / teledeath)
void EntMoverSpecial(edict_t *player)
{
	entvars_t *pev = &player->v;
	Vector ang = pev->v_angle + pev->punchangle;
	UTIL_MakeVectors(ang);
	Vector vecSrc = pev->origin + pev->view_ofs;
	Vector vecEnd = vecSrc + gpGlobals->v_forward * 10240.0f;
	TraceResult tr;
	UTIL_TraceLine(vecSrc, vecEnd, dont_ignore_monsters, player, &tr);
	edict_t *pHit = tr.pHit;
	const char *cn = STRING(pHit->v.classname);
	if (FStrEq(cn, "worldspawn") || FStrEq(cn, "DF_radio") ||
	    FStrEq(cn, "building_sentrygun") || FStrEq(cn, "building_sentrygun_base") ||
	    FStrEq(cn, "func_seethrough"))
		return;

	MoverKillEffect(player, tr.vecEndPos);

	if (!FStrEq(STRING(pHit->v.classname), "player"))
		KillEntity(pHit, player);
	else if (IsAlive(pHit))
		MoverTeleDeath(pHit, 50000.0f);
}

// EntMoverContinue @0x51b80  -- per-frame drag of the held entity
void EntMoverContinue(edict_t *player)
{
	char *nw = NWslot(player);
	edict_t *pEnt = *(edict_t **)(nw + 0x28);
	if (!UTIL_IsValidEntity(pEnt))
	{
		EMIT_SOUND_DYN(player, 3, "common/null.wav", 1.0f, 0.8f, 0, 100);
		EntMoverDestroyEffect(player);
		*(int *)(nw + 0x10) = 1;
		*(edict_t **)(nw + 0x28) = 0;
		return;
	}
	entvars_t *pev = &player->v;
	Vector ang = pev->v_angle + pev->punchangle;
	UTIL_MakeVectors(ang);
	Vector vecSrc = pev->origin + pev->view_ofs;
	float dist = *(float *)(nw + 0x2c);
	Vector vecEnd = vecSrc + gpGlobals->v_forward * dist;
	TraceResult tr;
	UTIL_TraceLine(vecSrc, vecEnd, ignore_monsters, pEnt, &tr);

	EntMoverUpdateEffect(pev->origin, tr.vecEndPos, player);

	Vector endSnap = *(Vector *)(nw + 0x3c);
	Vector entSnap = *(Vector *)(nw + 0x30);
	Vector newOrigin = tr.vecEndPos - (endSnap - entSnap);
	g_engfuncs.pfnSetOrigin(pEnt, newOrigin);
}

// EntMoverOff @0x51e30  -- release the held entity
void EntMoverOff(edict_t *player)
{
	char *nw = NWslot(player);
	edict_t *pEnt = *(edict_t **)(nw + 0x28);
	EMIT_SOUND_DYN(player, 3, "common/null.wav", 1.0f, 0.8f, 0, 100);
	EntMoverDestroyEffect(player);

	bool restored = false;
	if (UTIL_IsValidEntity(pEnt) && FStrEq(STRING(pEnt->v.classname), "player"))
	{
		pEnt->v.movetype = *(int *)(nw + 0x24);
		restored = true;
	}
	if (!restored && UTIL_IsValidEntity(pEnt))
	{
		// non-player release -> record a movement undo (action 1) on the shared ring, so
		// e_undo can return the entity to where it was grabbed.
		MoverState &mg = MV(player);
		PushMoveUndo(player, pEnt, mg.mgStart, mg.mgEnd);
	}

	*(edict_t **)(nw + 0x28) = 0;
	*(Vector *)(nw + 0x3c) = Vector(0, 0, 0);
	*(Vector *)(nw + 0x30) = Vector(0, 0, 0);
	*(float *)(nw + 0x2c) = 0.0f;
	MoverState &m = MV(player);
	m.mgActive = 0;
	m.mgEnt = NULL;
}

// result of the most recent DFLoadEntFile replay; es_load reads these to arm multi-move mode
static int    s_loadCount;
static int    s_loadEnts[128];
static bool   s_loadHasInfo;
static Vector s_loadInfoOrigin;

// DFLoadEntFile -- replay a saved entity file (es_save format), spawning each { } block as an
// entity at its stored origin/angles. Factored out of es_load (DFEntMover @0x49170, ~0x4c74e)
// so the save-preset autoloader can reuse it. absolute=true: path is the full file path;
// false: path is relative to the EntMod entsave directory. Returns the spawn count, -1 on open.
int DFLoadEntFile(const char *path, bool absolute)
{
	char full[512];
	if (absolute)
		snprintf(full, sizeof(full), "%s", path);
	else
		snprintf(full, sizeof(full), "%s/addons/EntMod/entsave/%s", moddir, path);

	FILE *f = fopen(full, "rt");
	if (!f)
		return -1;

	char msg[1024];
	msg[0] = 0;
	bool inBlock = false, inInfo = false, hasInfo = false;
	Vector origin(0, 0, 0), angles(0, 0, 0), infoOrigin(0, 0, 0);
	int count = 0;

	char line[2048];
	while (!feof(f))
	{
		if (!fgets(line, sizeof(line), f))
			continue;
		char *s = strTrim(line);
		char c = s[0];
		if (c == '#' || strncmp(s, "//", 2) == 0 || c == '\n' || c == '\0')
			continue;

		if (!inBlock)
		{
			inBlock = (c == '{');
			continue;
		}
		if (c == '}')
		{
			if (msg[0] == '\0' || inInfo)
			{
				inInfo  = false;
				inBlock = false;
			}
			else
			{
				edict_t *e = AddGameEntity(msg);
				if (e)
				{
					e->v.origin = origin;
					e->v.angles = angles;
					g_engfuncs.pfnSetOrigin(e, origin);
					if (count < 128)
						s_loadEnts[count] = EIDX(e);
				}
				msg[0] = '\0';
				count++;
				inBlock = false;
			}
			continue;
		}

		char *key = strtok(s, "\"");
		if (key) key = strTrim(key);
		char *val = strtok(NULL, "\"");
		if (val) val = strRemoveReturn(val);
		if (val && key)
		{
			if (!FStrEq(key, "classname"))
			{
				if (inInfo)
				{
					if (FStrEq(key, "origin"))
						UTIL_StringToVector(&infoOrigin.x, val);
				}
				else
				{
					if (FStrEq(key, "origin"))
						UTIL_StringToVector(&origin.x, val);
					if (FStrEq(key, "angles"))
						UTIL_StringToVector(&angles.x, val);
					char kv[512];
					snprintf(kv, sizeof(kv), ":%s:%s", key, val);
					strncat(msg, kv, sizeof(msg) - strlen(msg) - 1);
				}
			}
			else if (FStrEq(val, "DFs_save_info"))
			{
				hasInfo = true;
				inInfo  = true;
			}
			else
				snprintf(msg, sizeof(msg), "%s", val);
		}
	}
	if (inBlock)
		ALERT(at_console, "Error: Unexpected end of file.\n");
	fclose(f);

	s_loadCount      = count;
	s_loadHasInfo    = hasInfo;
	s_loadInfoOrigin = infoOrigin;
	return count;
}

// DFEntMover @0x49170  -- the entmover_* console command parser. Returns 1 when a command
// was handled, 0 otherwise (the admin gate is applied by the caller, DFClientCommand).
int DFEntMover(edict_t *player)
{
	entvars_t *pev = &player->v;
	int handled = 0;
	const char *c0 = Cmd_Argv(0);

	// entmover: e_telestart
	if (FStrEq(c0, "e_telestart"))
	{
		if (Cmd_Argc() > 1)
		{
			edict_t *spr = g_engfuncs.pfnCreateNamedEntity(MAKE_STRING("env_sprite"));
			spr->v.origin = pev->origin;
			spr->v.rendermode = 5;
			spr->v.renderamt = 175.0f;
			KeyValueData kvd;
			kvd.szClassName = NULL; kvd.szKeyName = "model"; kvd.szValue = "sprites/enter1.spr"; kvd.fHandled = 0;
			m_DispatchKeyValue(spr, &kvd);
			kvd.szKeyName = "framerate"; kvd.szValue = "10"; kvd.fHandled = 0;
			m_DispatchKeyValue(spr, &kvd);
			m_DispatchSpawn(spr);
			edict_t *trig = g_engfuncs.pfnCreateNamedEntity(MAKE_STRING("trigger_teleport"));
			trig->v.euser1 = spr;
			trig->v.origin = pev->origin;
			sprintf(s_msg, "%s", Cmd_Argv(1));
			kvd.szKeyName = "target"; kvd.szValue = s_msg; kvd.fHandled = 0;
			m_DispatchKeyValue(trig, &kvd);
			kvd.szKeyName = "style"; kvd.szValue = "32"; kvd.fHandled = 0;
			m_DispatchKeyValue(trig, &kvd);
			m_DispatchSpawn(trig);
		}
		handled = 1; goto done;
	}
	// entmover: e_teleend
	if (FStrEq(c0, "e_teleend"))
	{
		if (Cmd_Argc() > 1)
		{
			edict_t *spr = g_engfuncs.pfnCreateNamedEntity(MAKE_STRING("env_sprite"));
			spr->v.origin = pev->origin;
			spr->v.rendermode = 5;
			spr->v.renderamt = 175.0f;
			KeyValueData kvd;
			kvd.szClassName = NULL; kvd.szKeyName = "model"; kvd.szValue = "sprites/exit1.spr"; kvd.fHandled = 0;
			m_DispatchKeyValue(spr, &kvd);
			kvd.szKeyName = "framerate"; kvd.szValue = "10"; kvd.fHandled = 0;
			m_DispatchKeyValue(spr, &kvd);
			m_DispatchSpawn(spr);
			edict_t *dest = g_engfuncs.pfnCreateNamedEntity(MAKE_STRING("info_teleport_destination"));
			dest->v.euser1 = spr;
			dest->v.origin = pev->origin;
			sprintf(s_msg, "%s", Cmd_Argv(1));
			kvd.szKeyName = "targetname"; kvd.szValue = s_msg; kvd.fHandled = 0;
			m_DispatchKeyValue(dest, &kvd);
			m_DispatchSpawn(dest);
		}
		handled = 1; goto done;
	}
	// entmover: e_teledelete
	if (FStrEq(c0, "e_teledelete"))
	{
		if (Cmd_Argc() > 1)
		{
			edict_t *e = NULL;
			while ((e = UTIL_FindEntityByClassname(e, "trigger_teleport")) != NULL)
			{
				if (strcasecmp(STRING(e->v.target), Cmd_Argv(1)) == 0)
				{
					e->v.flags |= 0x40000000;
					if (UTIL_IsValidEntity(e->v.euser1))
						e->v.euser1->v.flags |= 0x40000000;
				}
			}
			e = NULL;
			while ((e = UTIL_FindEntityByClassname(e, "info_teleport_destination")) != NULL)
			{
				if (strcasecmp(STRING(e->v.targetname), Cmd_Argv(1)) == 0)
				{
					e->v.flags |= 0x40000000;
					if (UTIL_IsValidEntity(e->v.euser1))
						e->v.euser1->v.flags |= 0x40000000;
				}
			}
		}
		handled = 1; goto done;
	}
	// entmover: t_select -- pick a brush entity as the train to lay a path for  @0x492e1
	if (FStrEq(c0, "t_select") && Cmd_Argc() > 1)
	{
		MoverState &m = MV(player);
		if (m.tSelected != 0)
		{
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] You can only select one entity at a time.\n", "Ent Mod"));
			handled = 1; goto done;
		}
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (FStrEq(STRING(pHit->v.classname), "worldspawn")) { handled = 1; goto done; }
		if (STRING(pHit->v.model)[0] == '*')
		{
			const char *bn = Cmd_Argv(1);
			if (strlen(bn) < 9)
			{
				m.tSelected = 1;
				m.tTrainIndex = EIDX(pHit);
				strncpy(m.tBaseName, bn, 9); m.tBaseName[8] = 0;
				m.savedRendermode  = pHit->v.rendermode;
				m.savedRenderamt   = pHit->v.renderamt;
				m.savedRenderfx    = pHit->v.renderfx;
				m.savedRendercolor = pHit->v.rendercolor;
				pHit->v.rendermode  = 1;
				pHit->v.renderamt   = 96.0f;
				pHit->v.renderfx    = 0;
				pHit->v.rendercolor = Vector(255, 255, 0);
			}
			else
				ClientPrint2(player, 1, UTIL_VarArgs("[%s] Base name must be 8 characters or less. Your's was %i characters.\n", "Ent Mod", (int)strlen(bn)));
		}
		else
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] You can only select brush entities.\n", "Ent Mod"));
		handled = 1; goto done;
	}
	// entmover: t_start -- arm the path recorder (DFPlayerPreThink drops the corners)  @0x4949d
	if (FStrEq(c0, "t_start"))
	{
		MoverState &m = MV(player);
		if (m.tSelected == 0)
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] Select a train with t_select first.\n", "Ent Mod"));
		else if (m.tCounter == 0)
		{
			MB(2, 23, NULL, NULL); WB(0x16); WS(EIDX(player)); WS(precached_models);
			WB(0x78); WB(0x32); WB(0); WB(0); WB(0xff); WB(0x80); ME();   // TE_BEAMFOLLOW
			UTIL_SayTextAll(UTIL_VarArgs("[%s] Admin %s is now in train editing mode.\n",
				"Ent Mod", STRING(pev->netname)), player);
			m.tCounter  = 1;
			m.tLastDrop = gpGlobals->time;
		}
		else
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] You're already moving a train.\n", "Ent Mod"));
		handled = 1; goto done;
	}
	// entmover: t_end -- close the path, build the func_train and start it  @0x494d4
	if (FStrEq(c0, "t_end"))
	{
		MoverState &m = MV(player);
		if (m.tSelected == 0)
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] Select a train with t_select first.\n", "Ent Mod"));
		else if (m.tCounter == 0)
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] Use t_start to start your path first.\n", "Ent Mod"));
		else
		{
			int counter = m.tCounter;
			edict_t *pc = AddGameEntity(UTIL_VarArgs("path_corner:targetname:%s_%i:target:%s_1",
				m.tBaseName, counter, m.tBaseName));
			if (pc)
				pc->v.origin = pev->origin;
			m.tCounter  = 0;
			m.tSelected = 0;
			m.tLastDrop = gpGlobals->time;
			UTIL_SayTextAll(UTIL_VarArgs("[%s] Admin %s is now in normal mode.\n",
				"Ent Mod", STRING(pev->netname)), player);
			MB(2, 23, NULL, NULL); WB(99); WS(EIDX(player)); ME();   // TE_KILLBEAM
			edict_t *train = EDICT(m.tTrainIndex);
			long speed = strtol(Cmd_Argv(1), NULL, 10);
			edict_t *nt = AddGameEntity(UTIL_VarArgs(
				"func_train:model:%s:angles:%f %f %f:origin:%f %f %f:target:%s_1:speed:%i",
				STRING(train->v.model),
				train->v.angles.x, train->v.angles.y, train->v.angles.z,
				train->v.origin.x, train->v.origin.y, train->v.origin.z,
				m.tBaseName, (int)speed));
			if (nt)
			{
				nt->v.rendermode    = m.savedRendermode;
				nt->v.renderamt     = m.savedRenderamt;
				nt->v.renderfx      = m.savedRenderfx;
				nt->v.rendercolor   = m.savedRendercolor;
				train->v.rendermode  = m.savedRendermode;
				train->v.renderamt   = m.savedRenderamt;
				train->v.renderfx    = m.savedRenderfx;
				train->v.rendercolor = m.savedRendercolor;
				m_DispatchSpawn(nt);
				m.tTrainIndex = EIDX(nt);
				m_DispatchUse(nt, player);
			}
		}
		handled = 1; goto done;
	}
	// entmover: t_go -- trigger the selected/built train  @0x49636
	if (FStrEq(c0, "t_go"))
	{
		edict_t *train = EDICT(MV(player).tTrainIndex);
		if (UTIL_IsValidEntity(train))
			m_DispatchUse(train, player);
		handled = 1; goto done;
	}
	// entmover: e_use
	if (FStrEq(c0, "e_use"))
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		m_DispatchUse(pHit, player);
		handled = 1; goto done;
	}
	// entmover: e_god
	if (FStrEq(c0, "e_god"))
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		const char *a1 = Cmd_Argv(1);
		if (!FStrEq(a1, "off") && !FStrEq(a1, "0"))
			pHit->v.takedamage = 0.0f;
		else
			pHit->v.takedamage = 1.0f;
		handled = 1; goto done;
	}
	// entmover: e_render
	if (FStrEq(c0, "e_render"))
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		int argc = Cmd_Argc();
		long v;
		if (argc >= 2 && argc <= 7)
		{
			v = strtol(Cmd_Argv(1), NULL, 10); if (v != -1) pHit->v.rendermode = (int)v;
			if (argc >= 3) { v = strtol(Cmd_Argv(2), NULL, 10); if (v != -1) pHit->v.renderamt = (float)v; }
			if (argc >= 4) { v = strtol(Cmd_Argv(3), NULL, 10); if (v != -1) pHit->v.renderfx = (int)v; }
			if (argc >= 5) { v = strtol(Cmd_Argv(4), NULL, 10); if (v != -1) pHit->v.rendercolor.x = (float)v; }
			if (argc >= 6) { v = strtol(Cmd_Argv(5), NULL, 10); if (v != -1) pHit->v.rendercolor.y = (float)v; }
			if (argc >= 7) { v = strtol(Cmd_Argv(6), NULL, 10); if (v != -1) pHit->v.rendercolor.z = (float)v; }
		}
		handled = 1; goto done;
	}
	// entmover: e_drop
	if (FStrEq(c0, "e_drop") && MV(player).grabEnt == 0 && MV(player).copyEnt == 0)
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
			g_engfuncs.pfnDropToFloor(pHit);
		handled = 1; goto done;
	}
	// entmover: e_rotate -- rotate the hit entity about the trace point  @0x495a3
	if (FStrEq(c0, "e_rotate"))
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
		{
			long a1 = strtol(Cmd_Argv(1), NULL, 10);
			long a2 = strtol(Cmd_Argv(2), NULL, 10);
			long a3 = strtol(Cmd_Argv(3), NULL, 10);
			Vector in = tr.vecEndPos - pHit->v.origin;
			Vector rotAngles((float)a3, (float)a1, (float)a2);
			Vector out(0, 0, 0);
			VectorRotate(in, rotAngles, &out);
			Vector newOrigin = tr.vecEndPos - out;
			ALERT(at_console, "In: %i %i %i - Out: %i %i %i - Origin: %i %i %i\n",
				iround(tr.vecEndPos.x), iround(tr.vecEndPos.y), iround(tr.vecEndPos.z),
				iround(out.x), iround(out.y), iround(out.z),
				iround(newOrigin.x), iround(newOrigin.y), iround(newOrigin.z));
			int argc = Cmd_Argc();
			if (argc == 2) pHit->v.angles.x += (float)a1;
			if (argc == 3) pHit->v.angles.y += (float)a2;
			if (argc == 4) pHit->v.angles.z += (float)a3;
			if (pHit->v.angles.x >= 360.0f) pHit->v.angles.x -= 360.0f;
			if (pHit->v.angles.y >= 360.0f) pHit->v.angles.y -= 360.0f;
			if (pHit->v.angles.z >= 360.0f) pHit->v.angles.z -= 360.0f;
			pHit->v.origin = newOrigin;
			g_engfuncs.pfnSetOrigin(pHit, newOrigin);
		}
		handled = 1; goto done;
	}
	// entmover: e_rotate_x / e_rotate_y / e_rotate_z -- +15 degrees on one axis
	if (FStrEq(c0, "e_rotate_x"))
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
		{
			float a = pHit->v.angles.x + 15.0f;
			pHit->v.angles.x = (a >= 360.0f) ? a - 360.0f : a;
		}
		handled = 1; goto done;
	}
	if (FStrEq(c0, "e_rotate_y"))
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
		{
			float a = pHit->v.angles.y + 15.0f;
			pHit->v.angles.y = (a >= 360.0f) ? a - 360.0f : a;
		}
		handled = 1; goto done;
	}
	if (FStrEq(c0, "e_rotate_z"))
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
		{
			float a = pHit->v.angles.z + 15.0f;
			pHit->v.angles.z = (a >= 360.0f) ? a - 360.0f : a;
		}
		handled = 1; goto done;
	}
	// entmover: e_add
	if (FStrEq(c0, "e_add"))
	{
		sprintf(s_msg, "%i %i %i", iround(pev->origin.x), iround(pev->origin.y), iround(pev->origin.z));
		char args[1024];
		const char *a = Cmd_Args();
		strncpy(args, a ? a : "", sizeof(args) - 1);
		args[sizeof(args) - 1] = 0;
		UTIL_StringSearchReplace(args, "%HERE%", s_msg);
		AddGameEntity(args);
		handled = 1; goto done;
	}
	// entmover: e_kill
	if (FStrEq(c0, "e_kill") && MV(player).grabEnt == 0 && MV(player).esActive == 0 && MV(player).copyEnt == 0)
	{
		if (Cmd_Argc() < 3)
		{
			TraceResult tr;
			edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
			const char *cn = STRING(pHit->v.classname);
			if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "DF_radio") &&
			    !FStrEq(cn, "building_sentrygun") && !FStrEq(cn, "building_sentrygun_base") &&
			    !FStrEq(cn, "func_seethrough"))
			{
				MoverKillEffect(player, tr.vecEndPos);
				if (!FStrEq(STRING(pHit->v.classname), "player"))
					KillEntity(pHit, player);
				else if (IsAlive(pHit))
					MoverTeleDeath(pHit, 5000.0f);
			}
		}
		else
		{
			edict_t *pEnt = NULL;
			while ((pEnt = UTIL_FindEntityInSphere(pEnt, pev->origin, (float)strtod(Cmd_Argv(2), NULL))) != NULL)
			{
				if (Q_strcasestr(STRING(pEnt->v.classname), Cmd_Argv(1)))
				{
					const char *cn = STRING(pEnt->v.classname);
					if (strcasecmp(cn, "worldspawn") != 0 && strcasecmp(cn, "player") != 0 &&
					    !FStrEq(cn, "DF_radio") && !FStrEq(cn, "building_sentrygun") &&
					    !FStrEq(cn, "building_sentrygun_base") && !FStrEq(cn, "func_seethrough"))
						KillEntity(pEnt, player);
				}
			}
		}
		handled = 1; goto done;
	}
	// entmover: e_classname
	if (FStrEq(c0, "e_classname") && MV(player).grabEnt == 0 && MV(player).esActive == 0 && MV(player).copyEnt == 0)
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (pHit)
		{
			sprintf(s_msg, "%s", Cmd_Argv(1));
			KeyValueData kvd;
			kvd.szClassName = NULL; kvd.szKeyName = "classname"; kvd.szValue = s_msg; kvd.fHandled = 0;
			m_DispatchKeyValue(pHit, &kvd);
			strncpy(&Entities[EIDX(pHit) * 0x640], s_msg, 0x40);
		}
		handled = 1; goto done;
	}
	// entmover: grabtype -- grab the nearest entity of a classname for dragging
	if (FStrEq(c0, "grabtype") && MV(player).grabEnt == 0 && MV(player).esActive == 0 &&
	    MV(player).copyEnt == 0 && Cmd_Argc() > 1)
	{
		long rad = 0xfa;
		if (Cmd_Argc() > 2)
			rad = strtol(Cmd_Argv(2), NULL, 10);
		edict_t *pEnt = NULL;
		bool found = false;
		while ((pEnt = UTIL_FindEntityInSphere(pEnt, pev->origin, (float)rad)) != NULL)
		{
			if (strcasecmp(STRING(pEnt->v.classname), Cmd_Argv(1)) == 0) { found = true; break; }
		}
		if (!found || FStrEq(STRING(pEnt->v.classname), "worldspawn"))
		{
			sprintf(s_msg, "[%s] Did not find anything.\n", "Ent Mod");
			ClientPrint2(player, 3, s_msg);
			handled = 1; goto done;
		}
		sprintf(s_msg, "[%s] Grabbed %i\n", "Ent Mod", EIDX(pEnt));
		ClientPrint2(player, 3, s_msg);
		MoverState &m = MV(player);
		m.holdMode = 1;
		m.grabEnt = EIDX(pEnt);
		m.playerGrabOrigin = pev->origin;
		m.entGrabOrigin = pEnt->v.origin;
		m.savedRendermode = pEnt->v.rendermode;
		m.savedRenderamt = pEnt->v.renderamt;
		m.savedRenderfx = pEnt->v.renderfx;
		m.savedRendercolor = pEnt->v.rendercolor;
		m.savedMovetype = pEnt->v.movetype;
		m.savedEffects = pEnt->v.effects;
		pEnt->v.rendermode = 1;
		pEnt->v.renderamt = 96.0f;
		pEnt->v.renderfx = 0;
		pEnt->v.rendercolor = Vector(255, 0, 0);
		pEnt->v.effects &= ~0x80;
		if (FStrEq(STRING(pEnt->v.classname), "player"))
			pEnt->v.movetype = 8;
		handled = 1; goto done;
	}
	// entmover: stopgrab
	if (FStrEq(c0, "stopgrab") && MV(player).grabEnt != 0)
	{
		MoverState &m = MV(player);
		edict_t *pEnt = EDICT(m.grabEnt);
		if (UTIL_IsValidEntity(pEnt))
		{
			pEnt->v.rendermode = m.savedRendermode;
			pEnt->v.renderamt = m.savedRenderamt;
			pEnt->v.renderfx = m.savedRenderfx;
			pEnt->v.rendercolor = m.savedRendercolor;
			pEnt->v.effects = m.savedEffects;
			if (FStrEq(STRING(pEnt->v.classname), "player"))
				pEnt->v.movetype = m.savedMovetype;
		}
		m.holdMode = 0; m.grabEnt = 0;
		m.playerGrabOrigin = Vector(0, 0, 0); m.entGrabOrigin = Vector(0, 0, 0);
		m.savedRendermode = 0; m.savedRenderamt = 0; m.savedRenderfx = 0;
		m.savedRendercolor = Vector(0, 0, 0); m.savedMovetype = 0;
		handled = 1; goto done;
	}
	// entmover: +grabent -- crosshair-grab an entity for dragging (snapshot for the undo)  @0x4972d
	if (FStrEq(c0, "+grabent") && MV(player).grabEnt == 0 && MV(player).copyEnt == 0)
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		if (FStrEq(STRING(pHit->v.classname), "worldspawn"))
			pHit = DFFindEntityForward(player, 96.0f, NULL, player, true, false);
		if (pHit)
		{
			MoverState &m = MV(player);
			m.mgEnt    = pHit;
			m.mgActive = 1;
			m.mgStart  = pHit->v.origin;
			m.mgEnd    = pHit->v.origin;
			int ei = EIDX(pHit);
			strncpy(m.grabKeytext, EntKeytext(ei), 0x600);    m.grabKeytext[0x600 - 1] = 0;
			strncpy(m.grabClassname, EntClassname(ei), 0x40); m.grabClassname[0x40 - 1] = 0;
			m.holdMode = 1;
			m.grabEnt = ei;
			m.playerGrabOrigin = pev->origin;
			m.entGrabOrigin = pHit->v.origin;
			m.savedRendermode = pHit->v.rendermode;
			m.savedRenderamt = pHit->v.renderamt;
			m.savedRenderfx = pHit->v.renderfx;
			m.savedRendercolor = pHit->v.rendercolor;
			m.savedMovetype = pHit->v.movetype;
			m.savedEffects = pHit->v.effects;
			pHit->v.rendercolor = Vector(255, 0, 0);
			pHit->v.rendermode = 1;
			pHit->v.renderamt = 96.0f;
			pHit->v.renderfx = 0;
			pHit->v.effects &= ~0x80;
			if (FStrEq(STRING(pHit->v.classname), "player"))
				pHit->v.movetype = 8;
		}
		handled = 1; goto done;
	}
	// entmover: -grabent -- release the grab, record the move undo, restore the look  @0x49915
	if (FStrEq(c0, "-grabent") && MV(player).grabEnt != 0)
	{
		MoverState &m = MV(player);
		edict_t *pEnt = EDICT(m.grabEnt);
		if (UTIL_IsValidEntity(pEnt))
		{
			if (UTIL_IsValidEntity(m.mgEnt) && m.mgEnt == pEnt &&
			    !FStrEq(STRING(pEnt->v.classname), "player"))
				PushMoveUndo(player, pEnt, m.mgStart, m.mgEnd);
			pEnt->v.rendermode = m.savedRendermode;
			pEnt->v.renderamt = m.savedRenderamt;
			pEnt->v.renderfx = m.savedRenderfx;
			pEnt->v.rendercolor = m.savedRendercolor;
			pEnt->v.effects = m.savedEffects;
			if (FStrEq(STRING(pEnt->v.classname), "player"))
				pEnt->v.movetype = m.savedMovetype;
		}
		m.holdMode = 0; m.grabEnt = 0;
		m.playerGrabOrigin = Vector(0, 0, 0); m.entGrabOrigin = Vector(0, 0, 0);
		m.savedRendermode = 0; m.savedRenderamt = 0; m.savedRenderfx = 0;
		m.savedRendercolor = Vector(0, 0, 0); m.savedMovetype = 0;
		handled = 1; goto done;
	}
	// entmover: +rotate
	if (FStrEq(c0, "+rotate") && MV(player).grabEnt == 0 && MV(player).copyEnt == 0)
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		const char *cn = STRING(pHit->v.classname);
		if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "player"))
		{
			MoverState &m = MV(player);
			m.holdMode = 2;
			m.grabEnt = EIDX(pHit);
			m.playerGrabOrigin = pev->origin;
			m.entGrabOrigin = pHit->v.origin;
			m.savedRendermode = pHit->v.rendermode;
			m.savedRenderamt = pHit->v.renderamt;
			m.savedRenderfx = pHit->v.renderfx;
			m.savedRendercolor = pHit->v.rendercolor;
			Vector d = pev->angles - pHit->v.angles;
			m.savedAngles = UTIL_VecToAngles(d);
			pHit->v.rendermode = 1;
			pHit->v.renderamt = 96.0f;
			pHit->v.renderfx = 0;
			pHit->v.rendercolor = Vector(255, 255, 255);
		}
		handled = 1; goto done;
	}
	// entmover: -rotate
	if (FStrEq(c0, "-rotate") && MV(player).grabEnt != 0 && MV(player).holdMode == 2)
	{
		MoverState &m = MV(player);
		edict_t *pEnt = EDICT(m.grabEnt);
		if (UTIL_IsValidEntity(pEnt))
		{
			pEnt->v.rendermode = m.savedRendermode;
			pEnt->v.renderamt = m.savedRenderamt;
			pEnt->v.renderfx = m.savedRenderfx;
			pEnt->v.rendercolor = m.savedRendercolor;
		}
		m.holdMode = 2; m.grabEnt = 0;
		m.playerGrabOrigin = Vector(0, 0, 0); m.entGrabOrigin = Vector(0, 0, 0);
		m.savedRendermode = 0; m.savedRenderamt = 0; m.savedRenderfx = 0;
		m.savedRendercolor = Vector(0, 0, 0);
		handled = 1; goto done;
	}
	// entmover: showx / showy / showz -- draw a short axis beam at the player
	if (FStrEq(c0, "showx"))
	{
		MB(1, 23, NULL, player); WB(0);
		WC(pev->origin.x); WC(pev->origin.y); WC(pev->origin.z);
		WC(pev->origin.x + 128.0f); WC(pev->origin.y); WC(pev->origin.z);
		WS(precached_models); WB(0); WB(0); WB(0x1e); WB(10); WB(0);
		WB(0xff); WB(0); WB(0); WB(0x80); WB(0); ME();
		handled = 1; goto done;
	}
	if (FStrEq(c0, "showy"))
	{
		MB(1, 23, NULL, player); WB(0);
		WC(pev->origin.x); WC(pev->origin.y); WC(pev->origin.z);
		WC(pev->origin.x); WC(pev->origin.y + 128.0f); WC(pev->origin.z);
		WS(precached_models); WB(0); WB(0); WB(0x1e); WB(10); WB(0);
		WB(0); WB(0xff); WB(0); WB(0x80); WB(0); ME();
		handled = 1; goto done;
	}
	if (FStrEq(c0, "showz"))
	{
		MB(1, 23, NULL, player); WB(0);
		WC(pev->origin.x); WC(pev->origin.y); WC(pev->origin.z);
		WC(pev->origin.x); WC(pev->origin.y); WC(pev->origin.z + 128.0f);
		WS(precached_models); WB(0); WB(0); WB(0x1e); WB(10); WB(0);
		WB(0); WB(0); WB(0xff); WB(0x80); WB(0); ME();
		handled = 1; goto done;
	}
	// entmover: e_stack -- spawn <arg1> copies of the looked-at entity in a line  @0x49bb1
	if (FStrEq(c0, "e_stack") && MV(player).grabEnt == 0 && MV(player).copyEnt == 0 &&
	    MV(player).esActive == 0)
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		const char *cn = STRING(pHit->v.classname);
		long count = strtol(Cmd_Argv(1), NULL, 10);
		long dx = strtol(Cmd_Argv(2), NULL, 10);
		long dy = strtol(Cmd_Argv(3), NULL, 10);
		long dz = strtol(Cmd_Argv(4), NULL, 10);
		if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "player") &&
		    strncmp(cn, "building_", 9) != 0 && strncmp(cn, "DF_", 3) != 0)
		{
			for (long i = 1; i <= count; i++)
			{
				edict_t *clone = CloneEnt(pHit);
				if (clone)
				{
					Vector o(pHit->v.origin.x + (float)(dx * i),
					         pHit->v.origin.y + (float)(dy * i),
					         pHit->v.origin.z + (float)(dz * i));
					g_engfuncs.pfnSetOrigin(clone, o);
				}
			}
		}
		else
		{
			edict_t *src = DFFindEntityForward(player, 96.0f, NULL, NULL, false, true);
			if (src)
			{
				for (long i = 0; i <= count; i++)
				{
					edict_t *clone = CloneEnt(src);
					if (clone)
					{
						Vector o(src->v.origin.x + (float)(dx * i),
						         src->v.origin.y + (float)(dy * i),
						         src->v.origin.z + (float)(dz * i));
						g_engfuncs.pfnSetOrigin(clone, o);
					}
				}
			}
		}
		handled = 1; goto done;
	}
	// entmover: +copyent -- clone the looked-at entity and hold the copy for dragging  @0x49e0e
	if (FStrEq(c0, "+copyent") && MV(player).grabEnt == 0 && MV(player).copyEnt == 0 &&
	    MV(player).esActive == 0)
	{
		TraceResult tr;
		edict_t *pHit = MoverTraceForward(player, dont_ignore_monsters, &tr);
		const char *cn = STRING(pHit->v.classname);
		edict_t *src;
		if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "player") &&
		    strncmp(cn, "building_", 9) != 0 && strncmp(cn, "DF_", 3) != 0)
			src = pHit;
		else
			src = DFFindEntityForward(player, 96.0f, NULL, NULL, false, true);
		if (src)
		{
			edict_t *clone = CloneEnt(src);
			if (!clone)
				ClientPrint2(player, 1, "Null entity in +copyent!\n");
			else
			{
				MoverState &m = MV(player);
				m.holdMode = 1;
				m.copyEnt = EIDX(clone);
				m.playerGrabOrigin = pev->origin;
				m.entGrabOrigin = clone->v.origin;
				m.savedRendermode = clone->v.rendermode;
				m.savedRenderamt = clone->v.renderamt;
				m.savedRenderfx = clone->v.renderfx;
				m.savedRendercolor = clone->v.rendercolor;
				m.savedEffects = clone->v.effects;
				clone->v.rendermode = 1;
				clone->v.renderamt = 96.0f;
				clone->v.renderfx = 0;
				clone->v.rendercolor = Vector(255, 0, 255);
				clone->v.effects &= ~0x80;
			}
		}
		handled = 1; goto done;
	}
	// entmover: -copyent -- drop the held copy, restoring its look  @0x4a134
	if (FStrEq(c0, "-copyent") && MV(player).copyEnt != 0)
	{
		MoverState &m = MV(player);
		edict_t *clone = EDICT(m.copyEnt);
		if (clone)
		{
			clone->v.rendermode = m.savedRendermode;
			clone->v.renderamt = m.savedRenderamt;
			clone->v.renderfx = m.savedRenderfx;
			clone->v.rendercolor = m.savedRendercolor;
			clone->v.effects = m.savedEffects;
		}
		m.holdMode = 0; m.copyEnt = 0;
		m.playerGrabOrigin = Vector(0, 0, 0); m.entGrabOrigin = Vector(0, 0, 0);
		m.savedRendermode = 0; m.savedRenderamt = 0; m.savedRenderfx = 0;
		m.savedRendercolor = Vector(0, 0, 0);
		handled = 1; goto done;
	}
	// entmover: mm_start
	if (FStrEq(c0, "mm_start") && MV(player).mmActive == 0 && MV(player).esActive == 0)
	{
		MoverState &m = MV(player);
		m.mmActive = 1;
		m.mmInfoOrigin = pev->origin;
		handled = 1; goto done;
	}
	// entmover: mm_grab
	if (FStrEq(c0, "mm_grab"))
	{
		edict_t *pHit = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (!FStrEq(STRING(pHit->v.classname), "worldspawn"))
		{
			MoverState &m = MV(player);
			if (m.mmCount < 0x80)
			{
				MoverGrabSlot &s = m.mm[m.mmCount];
				s.entindex = EIDX(pHit);
				s.pad = 0;
				s.origin = pHit->v.origin;
				s.rendermode = pHit->v.rendermode;
				s.renderamt = pHit->v.renderamt;
				s.renderfx = pHit->v.renderfx;
				s.rendercolor = pHit->v.rendercolor;
				s.movetype = pHit->v.movetype;
				m.mmCount++;
				pHit->v.rendermode = 1;
				pHit->v.renderamt = 96.0f;
				pHit->v.renderfx = 0;
				pHit->v.rendercolor = Vector(0, 255, 0);
			}
			else
			{
				ClientPrint2(player, 3, UTIL_VarArgs("[%s] Can't grab any more entities.", "Ent Mod"));
			}
		}
		handled = 1; goto done;
	}
	// entmover: mm_end
	if (FStrEq(c0, "mm_end") && MV(player).mmActive != 0)
	{
		MoverState &m = MV(player);
		for (int i = 0; i < m.mmCount; i++)
		{
			MoverGrabSlot &s = m.mm[i];
			edict_t *pEnt = EDICT(s.entindex);
			s.entindex = 0;
			if (UTIL_IsValidEntity(pEnt))
			{
				pEnt->v.rendermode = s.rendermode;
				pEnt->v.renderamt = s.renderamt;
				pEnt->v.renderfx = s.renderfx;
				pEnt->v.rendercolor = s.rendercolor;
			}
		}
		m.mmActive = 0;
		m.mmCount = 0;
		handled = 1; goto done;
	}
	// entmover: e_show -- draw a bounding box + cross over every entity of a classname
	// (falls through to return 0, matching the original)
	if (FStrEq(c0, "e_show"))
	{
		edict_t *pEnt = NULL;
		while ((pEnt = UTIL_FindEntityByClassname(pEnt, Cmd_Argv(1))) != NULL)
		{
			entvars_t *e = &pEnt->v;
			Vector ctr;
			if (STRING(e->model)[0] == '*')
			{
				ctr.x = (e->maxs.x + e->mins.x) * 0.5f + e->origin.x;
				ctr.y = (e->maxs.y + e->mins.y) * 0.5f + e->origin.y;
				ctr.z = (e->maxs.z + e->mins.z) * 0.5f + e->origin.z;
			}
			else
				ctr = e->origin;
			Vector amin = e->origin + e->mins;
			Vector amax = e->origin + e->maxs;
			MB(0, 23, NULL, NULL); WB(0x1f);
			WC(amin.x); WC(amin.y); WC(amin.z);
			WC(amax.x); WC(amax.y); WC(amax.z);
			WS(100); WB(0); WB(0xff); WB(0); ME();
			MB(0, 23, NULL, NULL); WB(0);
			WC(ctr.x - 16.0f); WC(ctr.y); WC(ctr.z);
			WC(ctr.x + 16.0f); WC(ctr.y); WC(ctr.z);
			WS(precached_models); WB(0); WB(0); WB(100); WB(5); WB(0);
			WB(0); WB(0xff); WB(0); WB(0xff); WB(0x14); ME();
			MB(0, 23, NULL, NULL); WB(0);
			WC(ctr.x); WC(ctr.y); WC(ctr.z - 16.0f);
			WC(ctr.x); WC(ctr.y); WC(ctr.z + 16.0f);
			WS(precached_models); WB(0); WB(0); WB(100); WB(5); WB(0);
			WB(0); WB(0xff); WB(0); WB(0xff); WB(0x14); ME();
		}
	}
	// entmover: es_* -- entity-save selection + addons/EntMod/entsave file I/O. es_grab calls
	// DFEntSave(entity, player): the contract's (ent, player) order (the decompile's raw call is
	// DFEntSave(player, entity); admintools.cpp is built to the contract, so entity goes first).
	// es_start -- begin a save set; name the set and clear the selection  @0x4bebf
	if (FStrEq(c0, "es_start"))
	{
		MoverState &m = MV(player);
		strncpy(m.esSaveName, Cmd_Argv(1), 0x30); m.esSaveName[0x30 - 1] = 0;
		m.esInfoFlag = 0;
		m.esActive = 1;
		es_selectCount[EIDX(player)] = 0;
		handled = 1; goto done;
	}
	// es_grab -- select the looked-at entity, or every <classname> within <radius>  @0x4bf7a
	if (FStrEq(c0, "es_grab") && MV(player).esActive != 0)
	{
		edict_t *pEnt = NULL;
		if (Cmd_Argc() < 2)
		{
			TraceResult tr;
			pEnt = MoverTraceForward(player, ignore_monsters, &tr);
			if (UTIL_IsValidEntity(pEnt))
			{
				const char *cn = STRING(pEnt->v.classname);
				if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "player"))
					MoverSelectEffect(player, tr.vecEndPos);
			}
		}
		else
		{
			long rad = (Cmd_Argc() > 2) ? strtol(Cmd_Argv(2), NULL, 10) : 0xfa;
			while ((pEnt = UTIL_FindEntityInSphere(pEnt, pev->origin, (float)rad)) != NULL)
			{
				if (strcasecmp(STRING(pEnt->v.classname), Cmd_Argv(1)) == 0)
					break;
			}
		}
		if (UTIL_IsValidEntity(pEnt))
		{
			const char *cn = STRING(pEnt->v.classname);
			if (!FStrEq(cn, "worldspawn") && !FStrEq(cn, "player"))
				DFEntSave(pEnt, player);
		}
		handled = 1; goto done;
	}
	// es_graball -- select every entity of a classname (optionally matching a targetname)  @0x4c135
	if (FStrEq(c0, "es_graball"))
	{
		edict_t *pEnt = NULL;
		while ((pEnt = UTIL_FindEntityByClassname(pEnt, Cmd_Argv(1))) != NULL)
		{
			if (Cmd_Argc() > 2)
			{
				if (FStrEq(Cmd_Argv(2), STRING(pEnt->v.targetname)))
					DFEntSave(pEnt, player);
			}
			else
				DFEntSave(pEnt, player);
		}
		// falls through (returns 0, matching the original)
	}
	// es_ungrab -- drop the most recent selection, restoring its look  @0x4c1b2
	if (FStrEq(c0, "es_ungrab") && MV(player).esActive != 0)
	{
		int idx = EIDX(player);
		int last = es_selectCount[idx] - 1;
		if (last >= 0)
		{
			es_select_t &s = es_select[idx][last];
			edict_t *pEnt = EDICT(s.entindex);
			if (UTIL_IsValidEntity(pEnt) && EIDX(pEnt) != 0)
			{
				pEnt->v.rendermode  = s.rendermode;
				pEnt->v.renderamt   = s.renderamt;
				pEnt->v.renderfx    = s.renderfx;
				pEnt->v.rendercolor = s.rendercolor;
				pEnt->v.effects     = s.effects;
				ClientPrint2(player, 3, UTIL_VarArgs("[%s] Ungrabed ent %i (%s). Selected ent count: %i/128\n",
					"Ent Mod", EIDX(pEnt), STRING(pEnt->v.classname), last));
				es_selectCount[idx]--;
			}
		}
		// falls through (returns 0, matching the original)
	}
	// es_save -- write the selection to addons/EntMod/entsave/<map>_<name>.txt  @0x4c38c
	if (FStrEq(c0, "es_save") && MV(player).esActive != 0 && Cmd_Argc() == 2)
	{
		MoverState &m = MV(player);
		int idx = EIDX(player);
		char path[512];
		snprintf(path, sizeof(path), "%s/addons/EntMod/entsave/%s_%s.txt",
			moddir, STRING(gpGlobals->mapname), m.esSaveName);
		FILE *f = fopen(path, "wt");
		if (f)
		{
			if (strtol(Cmd_Argv(1), NULL, 10) == 1)
				fprintf(f, "{\n\tclassname \"DFs_save_info\n\torigin \"%i %i %i\n}\n",
					iround(pev->origin.x), iround(pev->origin.y), iround(pev->origin.z));
			for (int j = 0; j < es_selectCount[idx]; j++)
			{
				edict_t *pEnt = EDICT(es_select[idx][j].entindex);
				if (!UTIL_IsValidEntity(pEnt) || EIDX(pEnt) == 0 || OFFSET(pEnt) == 0)
					continue;
				int ei = EIDX(pEnt);
				char buf[2048];
				snprintf(buf, sizeof(buf), "%s:%s\n", EntClassname(ei), EntKeytext(ei));
				char *tok = strtok(buf, ":");
				char classname[128];
				strncpy(classname, tok ? tok : "", sizeof(classname) - 1);
				classname[sizeof(classname) - 1] = 0;
				fprintf(f, "{\n\tclassname \"%s\n", classname);
				char *key;
				while ((key = strtok(NULL, ":")) != NULL)
				{
					char *val = strtok(NULL, ":");
					if (val && !FStrEq(key, "rendermode") && !FStrEq(key, "renderamt") &&
					    !FStrEq(key, "renderfx") && !FStrEq(key, "angles") && !FStrEq(key, "origin"))
						fprintf(f, "\t%s \"%s\n", key, val);
				}
				es_select_t &s = es_select[idx][j];
				pEnt->v.rendermode  = s.rendermode;
				pEnt->v.renderamt   = s.renderamt;
				pEnt->v.renderfx    = s.renderfx;
				pEnt->v.rendercolor = s.rendercolor;
				pEnt->v.effects     = s.effects;
				fprintf(f, "\torigin \"%f %f %f\n\tangles \"%f %f %f\n\trendermode \"%i\n\trenderamt \"%f\n\trendercolor \"%f %f %f\n\trenderfx \"%i\n",
					pEnt->v.origin.x, pEnt->v.origin.y, pEnt->v.origin.z,
					pEnt->v.angles.x, pEnt->v.angles.y, pEnt->v.angles.z,
					pEnt->v.rendermode, pEnt->v.renderamt,
					pEnt->v.rendercolor.x, pEnt->v.rendercolor.y, pEnt->v.rendercolor.z,
					pEnt->v.renderfx);
				fwrite("}\n", 1, 2, f);
			}
			fclose(f);
		}
		m.esActive = 0;
		es_selectCount[idx] = 0;
		handled = 1; goto done;
	}
	// es_load -- replay a saved file; a DFs_save_info header arms multi-move on the group  @0x4c74e
	if (FStrEq(c0, "es_load") && MV(player).mmActive == 0)
	{
		if (Cmd_Argc() > 1)
		{
			char path[512];
			snprintf(path, sizeof(path), "%s/addons/EntMod/entsave/%s_%s.txt",
				moddir, STRING(gpGlobals->mapname), Cmd_Argv(1));
			int n = DFLoadEntFile(path, true);
			if (n >= 0 && s_loadHasInfo)
			{
				MoverState &m = MV(player);
				m.mmActive = 1;
				m.mmInfoOrigin = s_loadInfoOrigin;
				m.mmCount = (s_loadCount > 128) ? 128 : s_loadCount;
				for (int i = 0; i < m.mmCount; i++)
				{
					edict_t *e = EDICT(s_loadEnts[i]);
					MoverGrabSlot &slot = m.mm[i];
					slot.entindex = s_loadEnts[i];
					slot.pad = 0;
					if (UTIL_IsValidEntity(e))
					{
						slot.origin = e->v.origin;
						slot.rendermode = e->v.rendermode;
						slot.renderamt = e->v.renderamt;
						slot.renderfx = e->v.renderfx;
						slot.rendercolor = e->v.rendercolor;
						e->v.rendermode = 1;
						e->v.renderamt = 96.0f;
						e->v.renderfx = 0;
						e->v.rendercolor = Vector(0, 255, 0);
					}
				}
			}
		}
		handled = 1; goto done;
	}
	// entmover: e_undo -- pop the shared per-player undo ring (returns 0, matching the original)  @0x4ce3e
	if (FStrEq(c0, "e_undo"))
	{
		int idx = EIDX(player);
		int count = es_undoCount[idx];
		int slot  = count - 1;
		if (slot < 0)
		{
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] No undos left.\n", "Ent Mod"));
		}
		else
		{
			es_undo_t &u = es_undo[idx][slot];
			if (u.action == 1)
			{
				edict_t *pEnt = u.ent;
				if (!UTIL_IsValidEntity(pEnt))
					ClientPrint2(player, 3, UTIL_VarArgs("[%s] Movement undo failed.\n", "Ent Mod"));
				else
				{
					pEnt->v.origin = u.origin;
					g_engfuncs.pfnSetOrigin(pEnt, u.origin);
					ClientPrint2(player, 3, UTIL_VarArgs("[%s] Movement of %s Index: %i undoed.\n",
						"Ent Mod", STRING(pEnt->v.classname), EIDX(pEnt)));
				}
			}
			else if (u.action == 2)
			{
				char line[1024];
				snprintf(line, sizeof(line), "%s:%s", u.classname, u.text);
				edict_t *pEnt = AddGameEntity(line);
				if (!UTIL_IsValidEntity(pEnt))
					ClientPrint2(player, 3, UTIL_VarArgs("[%s] Deletion undo failed.\n", "Ent Mod"));
				else
				{
					g_engfuncs.pfnSetOrigin(pEnt, u.origin);
					pEnt->v.origin = u.origin;
					pEnt->v.angles = u.angles;
					pEnt->v.origin = u.origin;
					g_engfuncs.pfnSetOrigin(pEnt, u.origin);
					ClientPrint2(player, 3, UTIL_VarArgs("[%s] Deletion of %s undoed.\n",
						"Ent Mod", STRING(pEnt->v.classname)));
				}
			}
			es_undoCount[idx]--;
			int nextType = (count >= 2) ? es_undo[idx][count - 2].action : 0;
			const char *verb = (es_undoCount[idx] != 1) ? "are" : "is";
			const char *plural = (es_undoCount[idx] != 1) ? "s " : " ";
			ClientPrint2(player, 3, UTIL_VarArgs("[%s] There %s now %i undo%sleft. Next undo is type %i.\n",
				"Ent Mod", verb, es_undoCount[idx], plural, nextType));
		}
		// falls through (returns 0, matching the original)
	}

	handled = 0;
	// entmover: entmod_addpack -- spawn a backpack info_tfgoal ammo pack
	if (FStrEq(c0, "entmod_addpack"))
	{
		if (Cmd_Argc() > 2)
		{
			static const int ct[15] = {
				0xff, 0xff, 0xff,  0x10, 0x5f, 0xef,  0xf0, 0x0f, 0x0f,
				0xeb, 0xf0, 0x0f,  0x37, 0xff, 0xaf
			};
			long teamNo = strtol(Cmd_Argv(1), NULL, 10);
			char team[128];
			if (teamNo == 0)
				strcpy(team, "blank");
			else
				sprintf(team, "team_no:%i", (int)teamNo);
			long wait = strtol(Cmd_Argv(2), NULL, 10);
			int t = (int)teamNo;
			sprintf(s_msg,
				"info_tfgoal:origin:%i %i %i:%s:ammo_nails:500:ammo_rockets:500:ammo_cells:500:"
				"ammo_shells:500:ammo_detpack:500:no_grenades_1:4:no_grenades_2:4:g_e:1:g_a:1:"
				"goal_state:2:mdl:models/backpack.mdl:noise:weapons/scock1.wav:rendermode:0:"
				"renderfx:19:renderamt:15:rendercolor:%i %i %i:health:255:angles:0 %i 0:wait:%i",
				iround(pev->origin.x), iround(pev->origin.y), iround(pev->origin.z) - 0x10, team,
				ct[t * 3], ct[t * 3 + 1], ct[t * 3 + 2], iround(pev->angles.y), (int)wait);
			AddGameEntity(s_msg);
		}
		handled = 1;
		goto done;
	}

done:
	return handled;
}
