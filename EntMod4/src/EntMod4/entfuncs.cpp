#include "plugin.h"
#include <string.h>
#include <stdlib.h>

// EntMod4 -- reconstructed: shared entity helpers (entfuncs.cpp, @0x48280-0x572f0).
// The DFMoveableEnt/DFCopyableEnt pairs are the classname allow/deny filters the entity tools use
// to decide which entities may be grabbed by the mover or cloned by the copier. Each has a
// CBaseEntity* and an edict_t* overload with byte-identical logic; both reach the same entvars_t.

// CBaseEntity keeps entvars_t *pev as its first data member (ABI offset 4, after the vtable
// pointer); the contract leaves CBaseEntity incomplete, so reach pev through that fixed slot.
static inline entvars_t *CBE_pev(CBaseEntity *pEntity)
{
	return *reinterpret_cast<entvars_t **>(reinterpret_cast<char *>(pEntity) + sizeof(void *));
}

// Shared filter bodies over entvars_t; the four exported overloads delegate here.
static bool DF_IsMoveable(entvars_t *pev)
{
	const char *model = STRING(pev->model);
	const char *classname = STRING(pev->classname);

	if (FStrEq(classname, "worldspawn"))
		return false;
	if (model[0] == '*' &&
	    !FStrEq(classname, "func_water") &&
	    !FStrEq(classname, "func_door") &&
	    !FStrEq(classname, "func_illusionary"))
		return false;
	if (FStrEq(classname, "func_nogrenades"))
		return false;
	if (FStrEq(classname, "func_wall"))
		return false;
	if (FStrEq(classname, "env_bubbles"))
		return false;
	if (strncmp(classname, "trigger_", 8) == 0)
		return false;
	if (strncmp(classname, "tf_", 3) == 0)
		return false;
	return strncmp(classname, "weapon_", 7) != 0;
}

static bool DF_IsCopyable(entvars_t *pev)
{
	const char *model = STRING(pev->model);
	const char *classname = STRING(pev->classname);

	if (FStrEq(classname, "worldspawn"))
		return false;
	if (FStrEq(classname, "weaponbox"))
		return false;
	if (FStrEq(classname, "grenade"))
		return false;
	if (model[0] == '*' &&
	    !FStrEq(classname, "func_water") &&
	    !FStrEq(classname, "func_door") &&
	    !FStrEq(classname, "func_illusionary"))
		return false;
	if (FStrEq(classname, "func_nogrenades"))
		return false;
	if (FStrEq(classname, "func_wall"))
		return false;
	if (FStrEq(classname, "env_bubbles"))
		return false;
	if (FStrEq(classname, "player"))
		return false;
	if (strncmp(classname, "building_", 9) == 0)
		return false;
	if (strncmp(classname, "DF_", 3) == 0)
		return false;
	if (strncmp(classname, "trigger_", 8) == 0)
		return false;
	return strncmp(classname, "tf_", 3) != 0 && strncmp(classname, "weapon_", 7) != 0;
}

// DFMoveableEnt(CBaseEntity*) @0x48280
bool DFMoveableEnt(CBaseEntity *pEntity) { return DF_IsMoveable(CBE_pev(pEntity)); }

// DFCopyableEnt(CBaseEntity*) @0x483d0
bool DFCopyableEnt(CBaseEntity *pEntity) { return DF_IsCopyable(CBE_pev(pEntity)); }

// DFMoveableEnt(edict_t*) @0x485b0
bool DFMoveableEnt(edict_t *pent) { return DF_IsMoveable(&pent->v); }

// DFCopyableEnt(edict_t*) @0x48700
bool DFCopyableEnt(edict_t *pent) { return DF_IsCopyable(&pent->v); }

// DFGetOrigin @0x50ec0 -- world-space center of the entity (origin + half of the local bbox).
Vector DFGetOrigin(edict_t *pent)
{
	entvars_t *pev = &pent->v;
	Vector out;
	out.x = (pev->maxs.x + pev->mins.x) * 0.5f + pev->origin.x;
	out.y = (pev->maxs.y + pev->mins.y) * 0.5f + pev->origin.y;
	out.z = (pev->maxs.z + pev->mins.z) * 0.5f + pev->origin.z;
	return out;
}

// DFGetSize @0x50f20 -- half-extents of the entity's local bounding box.
Vector DFGetSize(edict_t *pent)
{
	entvars_t *pev = &pent->v;
	Vector out;
	out.x = (pev->maxs.x - pev->mins.x) * 0.5f;
	out.y = (pev->maxs.y - pev->mins.y) * 0.5f;
	out.z = (pev->maxs.z - pev->mins.z) * 0.5f;
	return out;
}

// DFFindEntityForward @0x53bd0 -- trace out of the player's eye; with radius 0 return the traced
// entity, otherwise return the nearest entity to the impact point passing the classname/filter tests.
edict_t *DFFindEntityForward(edict_t *player, float radius, const char *classname,
                             edict_t *ignore, bool movableOnly, bool copyableOnly)
{
	UTIL_MakeVectors(player->v.v_angle);
	Vector eye = player->v.origin + player->v.view_ofs;
	Vector end = eye + gpGlobals->v_forward * 10240.0f;
	TraceResult tr;
	UTIL_TraceLine(eye, end, dont_ignore_monsters, player, &tr);

	if (radius == 0.0f)
		return tr.pHit;

	edict_t *best = NULL;
	edict_t *pent = NULL;
	float bestDist = 10240.0f;
	while ((pent = UTIL_FindEntityInSphere(pent, tr.vecEndPos, radius)) != NULL)
	{
		float dist = (DFGetOrigin(pent) - tr.vecEndPos).Length();
		if (dist < bestDist &&
		    (classname == NULL || strcmp(classname, STRING(pent->v.classname)) == 0) &&
		    (!movableOnly || DFMoveableEnt(pent)) &&
		    (!copyableOnly || DFCopyableEnt(pent)) &&
		    (pent != ignore || ignore == NULL))
		{
			bestDist = dist;
			best = pent;
		}
	}
	return best;
}

// Create @0x53ea0 -- spawn a named entity at a position/orientation and give it an owner.
edict_t *Create(const char *classname, const Vector &origin, const Vector &angles, edict_t *owner)
{
	edict_t *pent = CREATE_NAMED_ENTITY(MAKE_STRING(classname));
	if (pent != NULL && OFFSET(pent) != 0)
	{
		pent->v.classname = MAKE_STRING(classname);
		pent->v.owner = owner;
		pent->v.origin = origin;
		pent->v.angles = angles;
		m_DispatchSpawn(pent);
		pent->v.classname = MAKE_STRING(classname);
		return pent;
	}
	ALERT(at_console, "NULL Ent in Create!\n");
	return NULL;
}

// D_GiveNamedItem @0x53fa0 -- spawn an item at the player's origin and touch it to the player.
edict_t *D_GiveNamedItem(edict_t *player, const char *classname)
{
	edict_t *pent = CREATE_NAMED_ENTITY(MAKE_STRING(classname));
	if (pent != NULL)
	{
		pent->v.spawnflags |= 0x40000000;
		pent->v.classname = MAKE_STRING(classname);
		pent->v.origin = player->v.origin;
		m_DispatchSpawn(pent);
		m_DispatchTouch(pent, player);
	}
	return pent;
}

// D_GiveNamedItem2 @0x54040 -- spawn an item at an explicit origin (no touch).
edict_t *D_GiveNamedItem2(edict_t *player, const char *classname, const Vector &origin)
{
	edict_t *pent = CREATE_NAMED_ENTITY(MAKE_STRING(classname));
	if (pent != NULL)
	{
		pent->v.classname = MAKE_STRING(classname);
		pent->v.origin = origin;
		pent->v.spawnflags |= 0x40000000;
		m_DispatchSpawn(pent);
	}
	return pent;
}

// GameCreateEntity @0x54c80 -- create a named entity, warning if the engine returns a null slot.
edict_t *GameCreateEntity(const char *classname)
{
	edict_t *pent = CREATE_NAMED_ENTITY(MAKE_STRING(classname));
	if (pent != NULL && OFFSET(pent) != 0)
		return pent;
	ALERT(at_console, "NULL Ent in CreateEntity!\n");
	return pent;
}

// GameKeyValue @0x54cd0 -- hand a key/value to the gamedll; if unhandled, apply "angle" as yaw.
void GameKeyValue(edict_t *pent, const char *classname, const char *key, const char *value)
{
	KeyValueData kvd;
	kvd.szClassName = (char *)classname;
	kvd.szKeyName = (char *)key;
	kvd.szValue = (char *)value;
	kvd.fHandled = 0;
	m_DispatchKeyValue(pent, &kvd);
	if (kvd.fHandled == 0 && key[0] != '\0' && FStrEq(key, "angle"))
	{
		pent->v.angles.x = 0;
		pent->v.angles.y = (float)strtod(value, NULL);
		pent->v.angles.z = 0;
	}
}

// AddGameEntity @0x54d90 -- parse a ":classname:key:value:..." line, spawn it and apply the keys.
edict_t *AddGameEntity(const char *line)
{
	char buf[1026];
	buf[0] = ':';
	buf[1] = '\0';
	strncpy(buf + 2, line, 0x400);
	buf[1025] = '\0';

	char classname[0x40];
	strncpy(classname, strtok(buf + 2, buf), sizeof(classname) - 1);
	classname[sizeof(classname) - 1] = '\0';

	edict_t *pent = GameCreateEntity(classname);
	if (pent == NULL || OFFSET(pent) == 0)
		return NULL;

	GameKeyValue(pent, "", "classname", classname);

	float bboxMin[3] = { 0, 0, 0 };
	float bboxMax[3] = { 0, 0, 0 };
	unsigned int flags = 0;
	char keyname[0x40];
	char value[0x100];
	for (;;)
	{
		char *k = strtok(NULL, buf);
		if (k == NULL)
			break;
		char *v = strtok(NULL, buf);
		if (v != NULL)
		{
			strncpy(keyname, k, sizeof(keyname) - 1);
			keyname[sizeof(keyname) - 1] = '\0';
			strncpy(value, v, sizeof(value) - 1);
			value[sizeof(value) - 1] = '\0';
			if (FStrEq(keyname, "bbox_min"))
			{
				flags |= 1;
				UTIL_StringToVector(bboxMin, value);
			}
			else if (FStrEq(keyname, "bbox_max"))
			{
				flags |= 2;
				UTIL_StringToVector(bboxMax, value);
			}
			else if (!FStrEq(keyname, "classname"))
			{
				GameKeyValue(pent, classname, keyname, value);
			}
		}
	}

	m_DispatchSpawn(pent);
	if (flags == 3)
		SET_SIZE(pent, bboxMin, bboxMax);
	return pent;
}

// DFNoBuildAreas @0x572f0 -- scan a sphere around the entity for build-blocking classnames.
// NOTE: the original returns int (1 = a blocking area is within range, 0 = none); the contract
// types this void, so the boolean verdict is dropped -- see deviations[].
void DFNoBuildAreas(edict_t *pent, int mode)
{
	edict_t *found = NULL;
	while ((found = UTIL_FindEntityInSphere(found, pent->v.origin, (float)mode)) != NULL)
	{
		const char *classname = STRING(found->v.classname);
		if (FStrEq(classname, "func_nobuild"))
			return;
		if (FStrEq(classname, "func_door"))
			return;
		if (FStrEq(classname, "func_door_rotating"))
			return;
		if (FStrEq(classname, "func_plat"))
			return;
		if (FStrEq(classname, "func_platrot"))
			return;
		if (FStrEq(classname, "func_nogrenades"))
			return;
		if (FStrEq(classname, "monster_turret"))
			return;
		if (FStrEq(classname, "monster_miniturret"))
			return;
		if (FStrEq(classname, "info_player_teamspawn"))
			return;
		if (FStrEq(classname, "func_conveyer"))
			return;
	}
}
