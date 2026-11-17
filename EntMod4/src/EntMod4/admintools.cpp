#include "plugin.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

// EntMod4 -- reconstructed: the entmod_* admin entity-command parser (DFEntAdmin) plus the
// entity-save (DFEntSave), undo-buffer (DFPrepareUndo) and chained-remove (KillEntity) helpers.
// Owns the es_ entity-save table Entities[] (classname at +0x0, keyvalue text at +0x40 of each
// 0x640-byte slot). The original packed the per-player undo ring and selected-entity list inside
// the 0xfd30-byte EntInfo3 player struct; the reconstructed EntInfo3 (plugin.h) keeps only the
// admin flags, so those two tables live here as module-local per-player state -- see deviations.

char Entities[1024 * 0x640];   // es_ save table: 1024 slots x 0x640; [+0]=classname[0x40], [+0x40]=keytext[0x600]

// ---- per-player entity-tool state (original: fields of the 0xfd30 EntInfo3 struct) ----
// The undo ring and the entity-save selection list are shared with entmover.cpp (es_ungrab/
// es_save/e_undo/+grabent and EntMoverOff). es_undo_t / es_select_t and the ES_MAX_* sizes are
// declared in the contract (entmod_decl.h); this TU is their single owning definition.

int         es_undoCount[ENT_MAXPLAYERS];
es_undo_t   es_undo[ENT_MAXPLAYERS][ES_MAX_UNDO];
int         es_selectCount[ENT_MAXPLAYERS];
es_select_t es_select[ENT_MAXPLAYERS][ES_MAX_SELECT];

static inline char *es_classname(int idx) { return Entities + idx * 0x640; }
static inline char *es_keytext(int idx)   { return Entities + idx * 0x640 + 0x40; }

// DFPrepareUndo @0x488d0 -- when the player's undo ring is full, shift every slot down one to free the top.
void DFPrepareUndo(edict_t *pent)
{
	int idx = ENTINDEX(pent);
	if (es_undoCount[idx] <= 0x1e)
		return;

	for (int i = 0; i < 0x1f; i++)
		es_undo[idx][i] = es_undo[idx][i + 1];
}

// KillEntity @0x48950 -- recursively remove the entity and anything it targets, recording an undo entry
// for the issuing player, then mark the edict FL_KILLME so the engine reaps it.
void KillEntity(edict_t *ent, edict_t *player)
{
	if (ent->v.target)
	{
		edict_t *child = NULL;
		while ((child = UTIL_FindEntityByString(child, "target", STRING(ent->v.target))) != NULL)
			KillEntity(child, player);
	}

	const char *classname = STRING(ent->v.classname);
	if (FStrEq(classname, "func_seethrough")) return;
	if (FStrEq(classname, "worldspawn"))      return;
	if (FStrEq(classname, "player"))          return;

	int idx  = ENTINDEX(player);
	int slot = es_undoCount[idx];
	DFPrepareUndo(player);

	es_undo_t *u = &es_undo[idx][slot];
	u->ent    = ent;
	u->action = 2;
	u->origin = ent->v.origin;
	u->angles = ent->v.angles;

	int entidx = ENTINDEX(ent);
	strncpy(u->text, es_keytext(entidx), 0x600);
	u->text[0x600 - 1] = '\0';
	strncpy(u->classname, es_classname(entidx), 0x40);
	u->classname[0x40 - 1] = '\0';

	if (slot < 0x1f)
		es_undoCount[idx]++;

	ent->v.flags |= FL_KILLME;
}

// DFEntSave @0x48b70 -- add an entity to the player's selected list (deduped, capped at 128), play a
// select sound, paint two green marker beams, and recolour the entity to show it is selected.
// NOTE: the binary calls this (player, entity); the contract names them (ent, player), so the roles
// are transposed relative to the raw decompile -- implemented to the contract (ent = the entity).
void DFEntSave(edict_t *ent, edict_t *player)
{
	int idx = ENTINDEX(player);

	if (es_selectCount[idx] > 0x7f)
	{
		ClientPrint2(player, 3, UTIL_VarArgs("[%s] Can't grab any more entities.", "Ent Mod"));
		return;
	}

	for (int i = 0; i < es_selectCount[idx]; i++)
	{
		if (es_select[idx][i].entindex == ENTINDEX(ent))
			return;
	}

	int count = es_selectCount[idx];
	ClientPrint2(player, 3, UTIL_VarArgs("[%s] Selected ent %i (%s). Selected ent count: %i/128\n",
		"Ent Mod", ENTINDEX(ent), STRING(ent->v.classname), count + 1));
	(*g_engfuncs.pfnEmitSound)(ent, 6, "buttons/bell1.wav", 1.0, 0.8, 0, 100);

	Vector pos;
	if (STRING(ent->v.model)[0] == '*')
	{
		pos.x = ent->v.origin.x + (ent->v.maxs.x + ent->v.mins.x) * 0.5f;
		pos.y = ent->v.origin.y + (ent->v.maxs.y + ent->v.mins.y) * 0.5f;
		pos.z = ent->v.origin.z + (ent->v.maxs.z + ent->v.mins.z) * 0.5f;
	}
	else
	{
		pos = ent->v.origin;
	}

	MESSAGE_BEGIN(MSG_BROADCAST, SVC_TEMPENTITY);
	WRITE_BYTE(TE_BEAMPOINTS);
	WRITE_COORD(pos.x - 16.0f); WRITE_COORD(pos.y); WRITE_COORD(pos.z);
	WRITE_COORD(pos.x + 16.0f); WRITE_COORD(pos.y); WRITE_COORD(pos.z);
	WRITE_SHORT(precached_models);
	WRITE_BYTE(0); WRITE_BYTE(0); WRITE_BYTE(100); WRITE_BYTE(5); WRITE_BYTE(0);
	WRITE_BYTE(0); WRITE_BYTE(255); WRITE_BYTE(0); WRITE_BYTE(255); WRITE_BYTE(20);
	MESSAGE_END();

	MESSAGE_BEGIN(MSG_BROADCAST, SVC_TEMPENTITY);
	WRITE_BYTE(TE_BEAMPOINTS);
	WRITE_COORD(pos.x); WRITE_COORD(pos.y); WRITE_COORD(pos.z - 16.0f);
	WRITE_COORD(pos.x); WRITE_COORD(pos.y); WRITE_COORD(pos.z + 16.0f);
	WRITE_SHORT(precached_models);
	WRITE_BYTE(0); WRITE_BYTE(0); WRITE_BYTE(100); WRITE_BYTE(5); WRITE_BYTE(0);
	WRITE_BYTE(0); WRITE_BYTE(255); WRITE_BYTE(0); WRITE_BYTE(255); WRITE_BYTE(20);
	MESSAGE_END();

	es_select_t *s = &es_select[idx][count];
	s->entindex    = ENTINDEX(ent);
	s->rendermode  = ent->v.rendermode;
	s->renderamt   = ent->v.renderamt;
	s->renderfx    = ent->v.renderfx;
	s->rendercolor = ent->v.rendercolor;
	s->effects     = ent->v.effects;
	es_selectCount[idx]++;

	ent->v.effects &= ~0x80;
	ent->v.rendermode    = 1;
	ent->v.renderamt     = 96.0f;
	ent->v.renderfx      = 0;
	ent->v.rendercolor.x = 0;
	ent->v.rendercolor.y = 0;
	ent->v.rendercolor.z = 255.0f;
}

// DFEntAdmin @0x46fc0 -- linear dispatch over the entmod_* entity commands. Returns 1 when a command
// was handled (so DFClientCommand supercedes), 0 when the command is none of these.
int DFEntAdmin(edict_t *player)
{
	// entmod_keys -- dump the looked-at entity's classname and saved key/value text.
	if (strcmp(Cmd_Argv(0), "entmod_keys") == 0)
	{
		edict_t *pEnt = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (!UTIL_IsValidEntity(pEnt))
			return 1;

		int idx = ENTINDEX(pEnt);
		char buf[2048];
		char field[1024];
		snprintf(buf, sizeof(buf), "%s:%s\n", Entities + idx * 0x640, Entities + idx * 0x640 + 0x40);

		char *tok = strtok(buf, ":");
		strncpy(field, tok ? tok : "", 0x80);
		field[0x80 - 1] = '\0';
		ClientPrint2(player, 1, UTIL_VarArgs("Classname: %s\n", field));

		if (!pEnt || OFFSET(pEnt) == 0)
			return 1;

		char *key;
		while ((key = strtok(NULL, ":")) != NULL)
		{
			char *val = strtok(NULL, ":");
			if (val)
				ClientPrint2(player, 1, UTIL_VarArgs("Key: %s\nValue: %s\n", key, val));
		}
		return 1;
	}

	// entmod_lookingat -- print detailed info about the entity the player is aiming at.
	if (strcmp(Cmd_Argv(0), "entmod_lookingat") == 0)
	{
		edict_t *pEnt = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (UTIL_IsValidEntity(pEnt))
		{
			char msg[1024];
			snprintf(msg, sizeof(msg), "Looking at '%s' '%i'\n",
				STRING(pEnt->v.classname), pEnt->v.health);
			ClientPrint2(player, 1, msg);
			snprintf(msg, sizeof(msg), "MODEL:'%s'('%i') '%i' FLAGS: %i DEADFLAG: %i\n",
				STRING(pEnt->v.model), pEnt->v.model, pEnt->v.modelindex, pEnt->v.flags, pEnt->v.deadflag);
			ClientPrint2(player, 1, msg);
			snprintf(msg, sizeof(msg), "X: '%i' Y: '%i' Z: '%i'\n",
				(int)pEnt->v.origin.x, (int)pEnt->v.origin.y, (int)pEnt->v.origin.z);
			ClientPrint2(player, 1, msg);
			snprintf(msg, sizeof(msg), "Movetype: %i Solid: %i\n", pEnt->v.movetype, pEnt->v.solid);
			ClientPrint2(player, 1, msg);
			snprintf(msg, sizeof(msg), "Mins: %f %f %f\n",
				pEnt->v.mins.x, pEnt->v.mins.y, pEnt->v.mins.z);
			ClientPrint2(player, 1, msg);
			snprintf(msg, sizeof(msg), "Maxs: %f %f %f\n",
				pEnt->v.maxs.x, pEnt->v.maxs.y, pEnt->v.maxs.z);
			ClientPrint2(player, 1, msg);
		}
		return 1;
	}

	// entmod_bomb -- hand the player a weapon_c4 and lob a live, fused one forward.
	if (strcmp(Cmd_Argv(0), "entmod_bomb") == 0)
	{
		edict_t *pC4 = D_GiveNamedItem(player, "weapon_c4");
		if (pC4 && OFFSET(pC4))
		{
			if (Cmd_Argc() > 1)
				pC4->v.nextthink = gpGlobals->time + (float)atof(Cmd_Argv(1));

			float delay = 10.0f;
			if (Cmd_Argc() > 1)
				delay = (float)atof(Cmd_Argv(1));

			UTIL_MakeVectors(Vector(0, player->v.v_angle.y, 0));

			edict_t *pGren = CREATE_NAMED_ENTITY(MAKE_STRING("weapon_c4"));
			if (pGren && OFFSET(pGren))
			{
				pGren->v.owner         = player;
				pGren->v.origin        = player->v.origin + gpGlobals->v_forward * 128.0f;
				pGren->v.angles        = player->v.angles;
				pGren->v.pain_finished = delay + gpGlobals->time;
				pGren->v.health        = delay + gpGlobals->time;
				m_DispatchSpawn(pGren);
				SET_MODEL(pGren, "models/w_c4.mdl");
				pGren->v.pain_finished = delay + gpGlobals->time;
				pGren->v.health        = delay + gpGlobals->time;
				return 1;
			}
		}
		ALERT(at_console, "NULL Ent in Create!\n");
		return 1;
	}

	// entmod_worldcopy -- spawn a brush-model copy of the world at a given origin/angles/avelocity.
	if (strcmp(Cmd_Argv(0), "entmod_worldcopy") == 0)
	{
		edict_t *pEnt = CREATE_NAMED_ENTITY(MAKE_STRING("info_target"));
		m_DispatchSpawn(pEnt);
		pEnt->v.classname = MAKE_STRING("DF_worldcopy");

		pEnt->v.origin.x = (float)atof(Cmd_Argv(4));
		pEnt->v.origin.y = (float)atof(Cmd_Argv(5));
		pEnt->v.origin.z = (float)atof(Cmd_Argv(6));
		SET_MODEL(pEnt, UTIL_VarArgs("maps/%s.bsp", STRING(gpGlobals->mapname)));

		UTIL_SetSize(VARS(pEnt), Vector(-8192, -8192, -8192), Vector(8192, 8192, 8192));
		pEnt->v.solid    = 0;
		pEnt->v.movetype = 8;

		pEnt->v.angles.x = (float)atof(Cmd_Argv(1));
		pEnt->v.angles.y = (float)atof(Cmd_Argv(2));
		pEnt->v.angles.z = (float)atof(Cmd_Argv(3));
		pEnt->v.avelocity.x = (float)atof(Cmd_Argv(7));
		pEnt->v.avelocity.y = (float)atof(Cmd_Argv(8));
		pEnt->v.avelocity.z = (float)atof(Cmd_Argv(9));
		return 1;
	}

	// entmod_create -- create a precached entity 128 units in front of the player.
	if (strcmp(Cmd_Argv(0), "entmod_create") == 0)
	{
		if (atoi(Cmd_Argv(2)) == 0)
		{
			edict_t *pEnt = UTIL_FindEntityByClassname((edict_t *)NULL, Cmd_Argv(1));
			if (!UTIL_IsValidEntity(pEnt))
			{
				ClientPrint2(player, 1, UTIL_VarArgs("[%s] Entity not precached.\n", "Ent Mod"));
				return 1;
			}
		}

		UTIL_MakeVectors(Vector(0, player->v.v_angle.y, 0));
		Vector origin;
		origin.x = gpGlobals->v_forward.x * 128.0f + player->v.origin.x;
		origin.y = gpGlobals->v_forward.y * 128.0f + player->v.origin.y;
		origin.z = gpGlobals->v_forward.z * 128.0f + player->v.origin.z;
		Create(Cmd_Argv(1), origin, player->v.angles, player);
		return 1;
	}

	// entmod_quickmake -- give the player a precached item directly.
	if (strcmp(Cmd_Argv(0), "entmod_quickmake") == 0)
	{
		if (atoi(Cmd_Argv(2)) == 0)
		{
			edict_t *pEnt = UTIL_FindEntityByClassname((edict_t *)NULL, Cmd_Argv(1));
			if (!UTIL_IsValidEntity(pEnt))
			{
				ClientPrint2(player, 1, UTIL_VarArgs("[%s] Entity not precached.\n", "Ent Mod"));
				return 1;
			}
		}
		D_GiveNamedItem(player, Cmd_Argv(1));
		return 1;
	}

	// entmod_spawn -- give an item at the player's origin plus an integer offset (args 2,3,4).
	if (strcmp(Cmd_Argv(0), "entmod_spawn") == 0)
	{
		if (atoi(Cmd_Argv(5)) == 0)
		{
			edict_t *pEnt = UTIL_FindEntityByClassname((edict_t *)NULL, Cmd_Argv(1));
			if (!UTIL_IsValidEntity(pEnt))
			{
				ClientPrint2(player, 1, UTIL_VarArgs("[%s] Entity not precached.\n", "Ent Mod"));
				return 1;
			}
		}
		Vector origin(player->v.origin.x + (float)atoi(Cmd_Argv(2)),
		              player->v.origin.y + (float)atoi(Cmd_Argv(3)),
		              player->v.origin.z + (float)atoi(Cmd_Argv(4)));
		D_GiveNamedItem2(player, Cmd_Argv(1), origin);
		return 1;
	}

	// entmod_spawn2 -- identical placement to entmod_spawn.
	if (strcmp(Cmd_Argv(0), "entmod_spawn2") == 0)
	{
		if (atoi(Cmd_Argv(5)) == 0)
		{
			edict_t *pEnt = UTIL_FindEntityByClassname((edict_t *)NULL, Cmd_Argv(1));
			if (!UTIL_IsValidEntity(pEnt))
			{
				ClientPrint2(player, 1, UTIL_VarArgs("[%s] Entity not precached.\n", "Ent Mod"));
				return 1;
			}
		}
		Vector origin(player->v.origin.x + (float)atoi(Cmd_Argv(2)),
		              player->v.origin.y + (float)atoi(Cmd_Argv(3)),
		              player->v.origin.z + (float)atoi(Cmd_Argv(4)));
		D_GiveNamedItem2(player, Cmd_Argv(1), origin);
		return 1;
	}

	// entmod_spawnmodel -- make a bare entity at the player's origin with a model and a toss velocity.
	if (strcmp(Cmd_Argv(0), "entmod_spawnmodel") == 0)
	{
		edict_t *pNew = CREATE_ENTITY();
		entvars_t *pev = pNew ? VARS(pNew) : NULL;
		pev->origin = player->v.origin;
		SET_MODEL(ENT(pev), Cmd_Argv(1));
		UTIL_SetSize(pev, Vector(0, 0, 0), Vector(0, 0, 0));

		pev->velocity = Vector((float)atoi(Cmd_Argv(2)),
		                       (float)atoi(Cmd_Argv(3)),
		                       (float)atoi(Cmd_Argv(4)));
		pev->solid    = 0;
		pev->movetype = (Cmd_Argv(2) == NULL) ? 6 : 10;
		pev->ltime    = gpGlobals->time;
		pev->frame    = 0;
		pev->flags    = 0;
		pev->nextthink = gpGlobals->time + RANDOM_FLOAT(10.0, 20.0);
		return 1;
	}

	// e_search -- list every entity within 100 units of the player.
	if (strcmp(Cmd_Argv(0), "e_search") == 0)
	{
		edict_t *pEnt = NULL;
		ClientPrint2(player, 2, "searching...\n");
		while ((pEnt = UTIL_FindEntityInSphere(pEnt, player->v.origin, 100.0f)) != NULL)
		{
			int owner = -1;
			if (pEnt->v.owner)
				owner = ENTINDEX(pEnt->v.owner);

			char buf[1024];
			snprintf(buf, sizeof(buf),
				"{EntMod} <%s (0x%x) ent index: %d> <owner ent index: %d> <controller: %d/%d/%d/%d>\n",
				STRING(pEnt->v.classname), (unsigned int)pEnt, ENTINDEX(pEnt), owner,
				pEnt->v.controller[0], pEnt->v.controller[1],
				pEnt->v.controller[2], pEnt->v.controller[3]);
			ClientPrint2(player, 2, buf);
			snprintf(buf, sizeof(buf),
				"{EntMod} <angles: (%f, %f, %f)> <origin: (%f, %f, %f)>\n",
				pEnt->v.angles.x, pEnt->v.angles.y, pEnt->v.angles.z,
				pEnt->v.origin.x, pEnt->v.origin.y, pEnt->v.origin.z);
			ClientPrint2(player, 2, buf);
		}
		return 1;
	}

	// entmod_keyvalue -- push a key/value pair into the looked-at entity's keyvalue handler.
	if (strcmp(Cmd_Argv(0), "entmod_keyvalue") == 0)
	{
		edict_t *pEnt = DFFindEntityForward(player, 0.0f, NULL, NULL, false, false);
		if (pEnt)
		{
			char value[128];
			char key[128];
			snprintf(value, sizeof(value), "%s", Cmd_Argv(2));
			snprintf(key, sizeof(key), "%s", Cmd_Argv(1));

			KeyValueData kvd;
			kvd.szClassName = NULL;
			kvd.szKeyName   = key;
			kvd.szValue     = value;
			kvd.fHandled    = 0;
			m_DispatchKeyValue(pEnt, &kvd);
		}
		return 1;
	}

	// entmod_noclip -- toggle the player's own noclip.
	if (strcmp(Cmd_Argv(0), "entmod_noclip") == 0)
	{
		if (strcmp(Cmd_Argv(1), "off") != 0 && strcmp(Cmd_Argv(1), "0") != 0)
			player->v.movetype = 8;
		else
			player->v.movetype = 3;
		return 1;
	}

	return 0;
}
