#include "plugin.h"
#include <math.h>
#ifdef _WIN32
#include <string.h>
#else
#include <strings.h>
#endif

// EntMod4 -- reconstructed: SDK / engine helpers (original util.cpp, @0x540d0-0x57c20).
// Most are verbatim HLSDK / The Specialists util.cpp helpers that EntMod copied; a handful are
// EntMod-specific (name lookup, menu, team color, trajectory and reflect math). Entvars access
// uses SDK field names (pev->origin, pev->flags, ...); the metamod-r HLSDK headers in include/
// produce the same struct layout as the original binary, so no raw offsets are needed. The
// CBaseEntity overloads treat CBaseEntity as opaque (no cbase.h is pulled anywhere in this tree):
// the pev pointer sits right after the vtable and the instance pointer is the edict's private data.

// zerogxplode/bubble sprite index: no recovered symbol; precached elsewhere in the real game.
// Keep it a file-static so the (mm-build-dead) UTIL_BubbleTrail still compiles and links.
static int g_sModelIndexBubbles = 0;

// CBaseEntity::pev lives immediately after the vtable pointer.
static inline entvars_t *CBE_pev(CBaseEntity *p) { return *(entvars_t **)((char *)p + 4); }

static short FixedSigned16(float value, float scale)
{
	int out = (int)(value * scale);
	if (out > 32767)
		out = 32767;
	else if (out < -32768)
		out = -32768;
	return (short)out;
}

static unsigned short FixedUnsigned16(float value, float scale)
{
	int out = (int)(value * scale);
	if (out < 0)
		out = 0;
	else if (out > 0xFFFF)
		out = 0xFFFF;
	return (unsigned short)out;
}

// EntMod's ScreenFade packing struct (UTIL_ScreenFadeBuild writes it, UTIL_ScreenFadeWrite sends it).
struct ScreenFade
{
	unsigned short duration;
	unsigned short holdTime;
	short          fadeFlags;
	byte           r, g, b, a;
};

int UTIL_IsValidEntity(edict_t *pent)   // UTIL_IsValidEntity @0x56120
{
	if (!pent || pent->free)
		return 0;
	if (pent->v.flags & FL_KILLME)
		return 0;
	return 1;
}

char *UTIL_VarArgs(char *format, ...)   // UTIL_VarArgs @0x56140
{
	va_list argptr;
	static char string[1024];

	va_start(argptr, format);
	vsnprintf(string, sizeof(string), format, argptr);
	va_end(argptr);
	return string;
}

void UTIL_LogPrintf(const char *fmt, ...)   // UTIL_LogPrintf @0x56e30
{
	va_list argptr;
	static char string[1024];

	va_start(argptr, fmt);
	vsnprintf(string, sizeof(string), fmt, argptr);
	va_end(argptr);
	ALERT(at_logged, "[ENTMOD] %s", string);
}

Vector UTIL_VecToAngles(const Vector &vec)   // UTIL_VecToAngles @0x545d0
{
	float out[3];
	VEC_TO_ANGLES(vec, out);
	return Vector(out);
}

// 6-arg (glass) overload; the 5-arg form is the util.h inline.
void UTIL_TraceLine(const Vector &start, const Vector &end, int ignoreMonsters,
                    int ignoreGlass, edict_t *skip, TraceResult *tr)   // UTIL_TraceLine @0x54610
{
	TRACE_LINE(start, end, (ignoreMonsters == 1 ? 1 : 0) | (ignoreGlass != 0 ? 0x100 : 0), skip, tr);
}

void UTIL_MakeVectors(const Vector &angles)   // UTIL_MakeVectors @0x54670
{
	MAKE_VECTORS(angles);
}

void UTIL_MakeAimVectors(const Vector &angles)   // UTIL_MakeAimVectors @0x54680
{
	float rgfl[3];
	angles.CopyToArray(rgfl);
	rgfl[0] = -rgfl[0];
	MAKE_VECTORS(rgfl);
}

int UTIL_PointContents(const Vector &vec)   // UTIL_PointContents @0x546b0
{
	return POINT_CONTENTS(vec);
}

void ClientPrint(entvars_t *client, int msgDest, const char *msgName, const char *p1,
                 const char *p2, const char *p3, const char *p4)   // ClientPrint @0x54700
{
	static int gmsgTextMsg = 0;
	if (!gmsgTextMsg)
		gmsgTextMsg = REG_USER_MSG("TextMsg", -1);

	MESSAGE_BEGIN(MSG_ONE_UNRELIABLE, gmsgTextMsg, NULL, ENT(client));
	WRITE_BYTE(msgDest);
	WRITE_STRING(msgName);
	if (p1)
		WRITE_STRING(p1);
	if (p2)
		WRITE_STRING(p2);
	if (p3)
		WRITE_STRING(p3);
	if (p4)
		WRITE_STRING(p4);
	MESSAGE_END();
}

void UTIL_SayText(const char *text, edict_t *to)   // UTIL_SayText @0x54800
{
	static int gmsgSayText = 0;
	if (!gmsgSayText)
		gmsgSayText = REG_USER_MSG("SayText", -1);

	MESSAGE_BEGIN(MSG_ONE, gmsgSayText, NULL, to);
	WRITE_BYTE(ENTINDEX(to));
	WRITE_STRING(text);
	MESSAGE_END();
}

bool IsAlive(edict_t *pent)   // IsAlive @0x54890
{
	entvars_t *pev = &pent->v;
	return (pev->deadflag == 0) && (pev->health > 0.0f);
}

bool FInViewCone(const Vector &origin, edict_t *looker)   // FInViewCone @0x548c0
{
	UTIL_MakeVectors(looker->v.angles);
	Vector2D los = (origin - looker->v.origin).Make2D();
	los = los.Normalize();
	float dot = DotProduct(los, gpGlobals->v_forward.Make2D());
	return dot > 0.5f;
}

bool FVisible(const Vector &origin, edict_t *looker)   // FVisible @0x54980
{
	entvars_t *pev = &looker->v;
	Vector look = pev->origin + pev->view_ofs;

	// Both ends must be on the same side of a water boundary to trace.
	if ((POINT_CONTENTS(origin) == CONTENTS_WATER) != (POINT_CONTENTS(look) == CONTENTS_WATER))
		return false;

	TraceResult tr;
	TRACE_LINE(look, origin, 0x101, looker, &tr);
	return tr.flFraction == 1.0f;
}

Vector GetGunPosition(edict_t *player)   // GetGunPosition @0x54a70
{
	return player->v.origin + player->v.view_ofs;
}

Vector VecBModelOrigin(edict_t *pent)   // VecBModelOrigin @0x54ab0
{
	return pent->v.absmin + pent->v.size * 0.5f;
}

void UTIL_ShowMenu(edict_t *player, int slots, int displayTime, bool needMore,
                   const char *text)   // UTIL_ShowMenu @0x54b00
{
	if (!gmsgShowMenu)
		gmsgShowMenu = REG_USER_MSG("ShowMenu", -1);

	MESSAGE_BEGIN(MSG_ONE, gmsgShowMenu, NULL, player);
	WRITE_SHORT(slots);
	WRITE_CHAR(displayTime);
	WRITE_BYTE(needMore);
	WRITE_STRING(text);
	MESSAGE_END();
}

TraceResult UTIL_GetGlobalTrace(void)   // UTIL_GetGlobalTrace @0x550e0
{
	TraceResult tr;
	tr.fAllSolid      = (int)gpGlobals->trace_allsolid;
	tr.fStartSolid    = (int)gpGlobals->trace_startsolid;
	tr.fInOpen        = (int)gpGlobals->trace_inopen;
	tr.fInWater       = (int)gpGlobals->trace_inwater;
	tr.flFraction     = gpGlobals->trace_fraction;
	tr.vecEndPos      = gpGlobals->trace_endpos;
	tr.flPlaneDist    = gpGlobals->trace_plane_dist;
	tr.vecPlaneNormal = gpGlobals->trace_plane_normal;
	tr.pHit           = gpGlobals->trace_ent;
	tr.iHitgroup      = gpGlobals->trace_hitgroup;
	return tr;
}

void VectorRotateX(const Vector &in, float degrees, Vector *out)   // VectorRotateX @0x55180
{
	float rad = degrees * 3.1415927f / 180.0f;
	float s = sinf(rad), c = cosf(rad);
	out->x = in.x;
	out->y = in.y * c - in.z * s;
	out->z = c * in.z + s * in.y;
}

void VectorRotateY(const Vector &in, float degrees, Vector *out)   // VectorRotateY @0x551f0
{
	float rad = degrees * 3.1415927f / 180.0f;
	float s = sinf(rad), c = cosf(rad);
	out->x = in.z * s + in.x * c;
	out->y = in.y;
	out->z = c * in.z - s * in.x;
}

void VectorRotateZ(const Vector &in, float degrees, Vector *out)   // VectorRotateZ @0x55260
{
	float rad = degrees * 3.1415927f / 180.0f;
	float s = sinf(rad), c = cosf(rad);
	out->x = in.x * c - in.y * s;
	out->y = c * in.y + s * in.x;
	out->z = in.z;
}

void VectorRotate(const Vector &in, const Vector &angles, Vector *out)   // VectorRotate @0x552d0
{
	Vector a = in;
	VectorRotateZ(a, angles.z, out);
	Vector b = *out;
	Vector c;
	VectorRotateY(b, angles.y, &c);
	Vector d = c;
	VectorRotateX(d, angles.x, out);
}

// 7-arg (glass) reflect: bounce the line off impact planes up to depth times.
void UTIL_TraceReflect(const Vector &start, const Vector &end, int ignoreMonsters,
                       int ignoreGlass, edict_t *skip, TraceResult *tr, int depth)   // UTIL_TraceReflect @0x55370
{
	int flag = (ignoreMonsters == 1 ? 1 : 0) | (ignoreGlass != 0 ? 0x100 : 0);
	float sx = start.x, sy = start.y, sz = start.z;
	float ex = end.x, ey = end.y, ez = end.z;

	for (int i = 0; i < depth; i++)
	{
		TRACE_LINE(Vector(sx, sy, sz), Vector(ex, ey, ez), flag, skip, tr);

		float dx = ex - sx, dy = ey - sy, dz = ez - sz;
		float len = sqrtf(dx * dx + dy * dy + dz * dz);
		float ndx, ndy, ndz;
		if (len == 0.0f) { ndx = 0.0f; ndy = 0.0f; ndz = 1.0f; }
		else { float inv = 1.0f / len; ndx = dx * inv; ndy = dy * inv; ndz = dz * inv; }

		Vector pn = tr->vecPlaneNormal;
		float dot2 = -2.0f * (ndx * pn.x + ndy * pn.y + ndz * pn.z);

		sx = tr->vecEndPos.x; sy = tr->vecEndPos.y; sz = tr->vecEndPos.z;
		ex = (pn.x * dot2 + ndx) * len;
		ey = (pn.y * dot2 + ndy) * len;
		ez = (pn.z * dot2 + ndz) * len;

		if (!(tr->flFraction < 1.0f))
			break;
	}
}

// 6-arg (no glass) reflect.
void UTIL_TraceReflect(const Vector &start, const Vector &end, int ignoreMonsters,
                       edict_t *skip, TraceResult *tr, int depth)   // UTIL_TraceReflect @0x55860
{
	int flag = (ignoreMonsters == 1 ? 1 : 0);
	float sx = start.x, sy = start.y, sz = start.z;
	float ex = end.x, ey = end.y, ez = end.z;

	for (int i = 0; i < depth; i++)
	{
		TRACE_LINE(Vector(sx, sy, sz), Vector(ex, ey, ez), flag, skip, tr);

		float dx = ex - sx, dy = ey - sy, dz = ez - sz;
		float len = sqrtf(dx * dx + dy * dy + dz * dz);
		float ndx, ndy, ndz;
		if (len == 0.0f) { ndx = 0.0f; ndy = 0.0f; ndz = 1.0f; }
		else { float inv = 1.0f / len; ndx = dx * inv; ndy = dy * inv; ndz = dz * inv; }

		Vector pn = tr->vecPlaneNormal;
		float dot2 = -2.0f * (ndx * pn.x + ndy * pn.y + ndz * pn.z);

		sx = tr->vecEndPos.x; sy = tr->vecEndPos.y; sz = tr->vecEndPos.z;
		ex = (pn.x * dot2 + ndx) * len;
		ey = (pn.y * dot2 + ndy) * len;
		ez = (pn.z * dot2 + ndz) * len;

		if (!(tr->flFraction < 1.0f))
			break;
	}
}

float UTIL_WaterLevel(const Vector &position, float minz, float maxz)   // UTIL_WaterLevel @0x55d40
{
	Vector midUp = position;
	midUp.z = minz;

	if (POINT_CONTENTS(midUp) != CONTENTS_WATER)
		return minz;

	midUp.z = maxz;
	if (POINT_CONTENTS(midUp) == CONTENTS_WATER)
		return maxz;

	float diff = maxz - minz;
	while (diff > 1.0f)
	{
		midUp.z = minz + diff * 0.5f;
		if (POINT_CONTENTS(midUp) == CONTENTS_WATER)
			minz = midUp.z;
		else
			maxz = midUp.z;
		diff = maxz - minz;
	}
	return midUp.z;
}

void UTIL_BubbleTrail(const Vector &from, const Vector &to, int count)   // UTIL_BubbleTrail @0x55e50
{
	float flHeight = UTIL_WaterLevel(from, from.z, from.z + 256.0f) - from.z;
	if (flHeight < 8.0f)
	{
		flHeight = UTIL_WaterLevel(to, to.z, to.z + 256.0f) - to.z;
		if (flHeight < 8.0f)
			return;
		flHeight = flHeight + to.z - from.z;
	}

	if (count > 255)
		count = 255;

	MESSAGE_BEGIN(MSG_BROADCAST, SVC_TEMPENTITY);
	WRITE_BYTE(TE_BUBBLETRAIL);
	WRITE_COORD(from.x);
	WRITE_COORD(from.y);
	WRITE_COORD(from.z);
	WRITE_COORD(to.x);
	WRITE_COORD(to.y);
	WRITE_COORD(to.z);
	WRITE_COORD(flHeight);
	WRITE_SHORT(g_sModelIndexBubbles);
	WRITE_BYTE(count);
	WRITE_COORD(8.0);
	MESSAGE_END();
}

edict_t *UTIL_FindEntityInSphere(edict_t *start, const Vector &center, float radius)   // UTIL_FindEntityInSphere @0x55fb0
{
	edict_t *e = FIND_ENTITY_IN_SPHERE(start, center, radius);
	if (e && OFFSET(e) == 0)
		e = NULL;
	return e;
}

CBaseEntity *UTIL_FindEntityInSphere(CBaseEntity *start, const Vector &center, float radius)   // UTIL_FindEntityInSphere @0x57290
{
	edict_t *s = start ? CBE_pev(start)->pContainingEntity : NULL;
	edict_t *e = FIND_ENTITY_IN_SPHERE(s, center, radius);
	if (e && OFFSET(e) != 0)
		return (CBaseEntity *)e->pvPrivateData;
	return NULL;
}

void UTIL_SayTextAll(const char *text, edict_t *from)   // UTIL_SayTextAll @0x56000
{
	static int gmsgSayText2 = 0;
	if (!gmsgSayText2)
		gmsgSayText2 = REG_USER_MSG("SayText", -1);

	MESSAGE_BEGIN(MSG_ALL, gmsgSayText2, NULL, (edict_t *)NULL);
	WRITE_BYTE(ENTINDEX(from));
	WRITE_STRING(text);
	MESSAGE_END();
}

void ClientPrint2(edict_t *player, int msgDest, const char *msg)   // ClientPrint2 @0x56090
{
	static int gmsgTextMsg2 = 0;
	if (!gmsgTextMsg2)
		gmsgTextMsg2 = REG_USER_MSG("TextMsg", -1);

	MESSAGE_BEGIN(MSG_ONE, gmsgTextMsg2, NULL, player);
	WRITE_BYTE(msgDest);
	WRITE_STRING(msg);
	MESSAGE_END();
}

// Probe the six box-face centers from a point; true only if every ray is unobstructed.
bool UTIL_CheckBox(const Vector &center, const Vector &extents)   // UTIL_CheckBox @0x56230
{
	TraceResult tr;
	Vector c = center;

	TRACE_LINE(c, Vector(c.x + extents.x * 0.5f, c.y, c.z), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	TRACE_LINE(c, Vector(c.x - extents.x * 0.5f, c.y, c.z), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	TRACE_LINE(c, Vector(c.x, c.y + extents.y * 0.5f, c.z), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	TRACE_LINE(c, Vector(c.x, c.y - extents.y * 0.5f, c.z), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	TRACE_LINE(c, Vector(c.x, c.y, c.z + extents.z * 0.5f), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	TRACE_LINE(c, Vector(c.x, c.y, c.z - extents.z * 0.5f), 0, 0, &tr);
	if (tr.flFraction != 1.0f) return false;
	return true;
}

Vector UTIL_TossAngleFromSpeed(const Vector &start, const Vector &end, float speed)   // UTIL_TossAngleFromSpeed @0x56530
{
	// The original computes the horizontal separation then returns scalar 0 (no usable result).
	float horiz2 = (end.y - start.y) * (end.y - start.y) + (end.x - start.x) * (end.x - start.x);
	(void)horiz2;
	(void)speed;
	return Vector(0, 0, 0);
}

float UTIL_TossSpeedFromAngle(const Vector &start, const Vector &end, float angle)   // UTIL_TossSpeedFromAngle @0x56580
{
	double horiz = sqrt((double)(end.y - start.y) * (end.y - start.y) +
	                    (double)(end.x - start.x) * (end.x - start.x));
	float pitch = (float)atan(((double)end.z - (double)start.z) / horiz);
	float launch = angle + pitch;
	if (launch >= 1.5707964f)
	{
		angle = 0.0f;
		launch = pitch;
	}

	float dist = sqrtf((end.z - start.z) * (end.z - start.z) +
	                   (end.y - start.y) * (end.y - start.y) +
	                   (end.x - start.x) * (end.x - start.x));
	float grav = CVAR_GET_FLOAT("sv_gravity");
	double cp = cos((double)pitch);
	double num = cp * cp * 0.65 * (double)dist * (double)grav;
	double den = (sin((double)angle) + sin((double)angle)) * cos((double)launch);
	float v = (float)(num / den);
	if (v < 0.0f)
		v = -v;
	return sqrtf(v);
}

// Returns a team / player-color index (TS teams, or a cstrike model / topcolor derived code).
Vector UTIL_GetTeamColor(edict_t *pent)   // UTIL_GetTeamColor @0x56710
{
	if (!pent)
		return Vector(-1, 0, 0);

	int code = 1;

	if (strcasecmp(moddir, "cstrike") == 0)
	{
		char model[32];
		const char *m = GET_KEY_VALUE(GET_INFO_BUFFER(pent), "model");
		strncpy(model, m ? m : "", 30);
		model[30] = 0;

		// Counter-Terrorist model families resolve to a fixed code; Terrorist families fall
		// through to the topcolor path below.
		if (!strcmp(model, "gign") || !strcmp(model, "gsg9") || !strcmp(model, "sas") ||
		    !strcmp(model, "urban") || !strcmp(model, "arctic"))
			return Vector((float)1, 0, 0);
		if (!strcmp(model, "vip") || !strcmp(model, "arab") || !strcmp(model, "guerilla") ||
		    !strcmp(model, "terror"))
			return Vector((float)code, 0, 0);
	}

	char top[32];
	const char *t = GET_KEY_VALUE(GET_INFO_BUFFER(pent), "topcolor");
	strncpy(top, t ? t : "", 31);
	top[31] = 0;

	code = 4;
	if (strcmp(top, "100") != 0 && strcmp(top, "80") != 0)
		code = pent->v.team;

	return Vector((float)code, 0, 0);
}

void UTIL_HudMessage(edict_t *pent, const hudtextparms_s &textparms, const char *message)   // UTIL_HudMessage @0x56a70
{
	if (!pent)
		return;
	if (g_engfuncs.pfnGetPlayerWONId(pent) == 0)
		return;

	MESSAGE_BEGIN(MSG_ONE, SVC_TEMPENTITY, NULL, pent);
	WRITE_BYTE(TE_TEXTMESSAGE);
	WRITE_BYTE(textparms.channel & 0xFF);
	WRITE_SHORT(FixedSigned16(textparms.x, 1 << 13));
	WRITE_SHORT(FixedSigned16(textparms.y, 1 << 13));
	WRITE_BYTE(textparms.effect);
	WRITE_BYTE(textparms.r1);
	WRITE_BYTE(textparms.g1);
	WRITE_BYTE(textparms.b1);
	WRITE_BYTE(textparms.a1);
	WRITE_BYTE(textparms.r2);
	WRITE_BYTE(textparms.g2);
	WRITE_BYTE(textparms.b2);
	WRITE_BYTE(textparms.a2);
	WRITE_SHORT(FixedUnsigned16(textparms.fadeinTime, 1 << 8));
	WRITE_SHORT(FixedUnsigned16(textparms.fadeoutTime, 1 << 8));
	WRITE_SHORT(FixedUnsigned16(textparms.holdTime, 1 << 8));

	if (textparms.effect == 2)
		WRITE_SHORT(FixedUnsigned16(textparms.fxTime, 1 << 8));

	if (strlen(message) < 512)
	{
		WRITE_STRING(message);
	}
	else
	{
		char tmp[512];
		strncpy(tmp, message, 511);
		tmp[511] = 0;
		WRITE_STRING(tmp);
	}
	MESSAGE_END();
}

void UTIL_HudMessageAll(const hudtextparms_s &textparms, const char *message)   // UTIL_HudMessageAll @0x56dd0
{
	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *pl = INDEXENT(i);
		if (pl)
			UTIL_HudMessage(pl, textparms, message);
	}
}

bool IsInWorld(edict_t *pent)   // IsInWorld @0x571a0
{
	entvars_t *pev = &pent->v;

	if (pev->origin.x >= 4096.0f || pev->origin.y >= 4096.0f || pev->origin.z >= 4096.0f)
		return false;
	if (pev->origin.x <= -4096.0f || pev->origin.y <= -4096.0f || pev->origin.z <= -4096.0f)
		return false;
	if (pev->velocity.x >= 2000.0f || pev->velocity.y >= 2000.0f || pev->velocity.z >= 2000.0f)
		return false;
	if (pev->velocity.x <= -2000.0f || pev->velocity.y <= -2000.0f || pev->velocity.z <= -2000.0f)
		return false;
	return true;
}

edict_t *UTIL_FindEntityByString(edict_t *start, const char *field, const char *value)   // UTIL_FindEntityByString @0x574d0
{
	edict_t *e = FIND_ENTITY_BY_STRING(start, field, value);
	if (e && OFFSET(e) == 0)
		e = NULL;
	return e;
}

CBaseEntity *UTIL_FindEntityByString(CBaseEntity *start, const char *field, const char *value)   // UTIL_FindEntityByString @0x57470
{
	edict_t *s = start ? CBE_pev(start)->pContainingEntity : NULL;
	edict_t *e = FIND_ENTITY_BY_STRING(s, field, value);
	if (e && OFFSET(e) != 0)
		return (CBaseEntity *)e->pvPrivateData;
	return NULL;
}

edict_t *UTIL_FindEntityByClassname(edict_t *start, const char *name)   // UTIL_FindEntityByClassname @0x57550
{
	return UTIL_FindEntityByString(start, "classname", name);
}

CBaseEntity *UTIL_FindEntityByClassname(CBaseEntity *start, const char *name)   // UTIL_FindEntityByClassname @0x57520
{
	return UTIL_FindEntityByString(start, "classname", name);
}

CBaseEntity *UTIL_FindEntityByTargetname(CBaseEntity *start, const char *name)   // UTIL_FindEntityByTargetname @0x57580
{
	return UTIL_FindEntityByString(start, "targetname", name);
}

edict_t *UTIL_FindEntityGeneric(const char *name, const Vector &source, float radius)   // UTIL_FindEntityGeneric @0x575b0
{
	edict_t *best = UTIL_FindEntityByString((edict_t *)NULL, "targetname", name);
	if (best)
		return best;

	float bestDist2 = radius * radius;
	edict_t *e = NULL;
	while ((e = UTIL_FindEntityByClassname(e, name)) != NULL)
	{
		float d2 = (e->v.origin - source).LengthSquared();
		if (d2 < bestDist2)
		{
			best = e;
			bestDist2 = d2;
		}
	}
	return best;
}

edict_t *UTIL_PlayerByIndex(int index)   // UTIL_PlayerByIndex @0x57670
{
	if (index > 0 && index <= gpGlobals->maxClients)
	{
		edict_t *p = INDEXENT(index);
		if (p && !p->free)
			return p;
	}
	return NULL;
}

void EMIT_SOUND_DYN(edict_t *entity, int channel, const char *sample, float volume,
                    float attenuation, int flags, int pitch)   // EMIT_SOUND_DYN @0x576b0
{
	// Sentence names ('!' prefix) are resolved engine-side; pass the sample through either way.
	EMIT_SOUND_DYN2(entity, channel, sample, volume, attenuation, flags, pitch);
}

void UTIL_ScreenShake(const Vector &center, float amplitude, float frequency, float duration,
                      float radius)   // UTIL_ScreenShake @0x57770
{
	unsigned short durFixed = FixedUnsigned16(duration, 1 << 12);
	unsigned short freqFixed = FixedUnsigned16(frequency, 1 << 8);

	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *pl = UTIL_PlayerByIndex(i);
		if (!pl || !(pl->v.flags & FL_ONGROUND))
			continue;

		if (radius > 0.0f)
		{
			float dist = (center - pl->v.origin).Length();
			if (dist >= radius)
				continue;
		}

		if (amplitude == 0.0f)
			continue;

		unsigned short ampFixed = FixedUnsigned16(amplitude, 1 << 12);
		int msg = REG_USER_MSG("ScreenShake", -1);
		MESSAGE_BEGIN(MSG_ONE, msg, NULL, pl);
		WRITE_SHORT(ampFixed);
		WRITE_SHORT(durFixed);
		WRITE_SHORT(freqFixed);
		MESSAGE_END();
	}
}

void UTIL_ScreenShakeAll(const Vector &center, float amplitude, float frequency,
                         float duration)   // UTIL_ScreenShakeAll @0x57970
{
	UTIL_ScreenShake(center, amplitude, frequency, duration, 0.0f);
}

void UTIL_ScreenFadeBuild(ScreenFade &fade, const Vector &color, float fadeTime, float holdTime,
                          int alpha, int flags)   // UTIL_ScreenFadeBuild @0x579b0
{
	fade.duration  = FixedUnsigned16(fadeTime, 1 << 12);
	fade.holdTime  = FixedUnsigned16(holdTime, 1 << 12);
	fade.r         = (byte)(int)color.x;
	fade.g         = (byte)(int)color.y;
	fade.b         = (byte)(int)color.z;
	fade.a         = (byte)alpha;
	fade.fadeFlags = (short)flags;
}

void UTIL_ScreenFadeWrite(const ScreenFade &fade, CBaseEntity *pEntity)   // UTIL_ScreenFadeWrite @0x57a80
{
	if (!pEntity)
		return;

	// CBaseEntity::IsNetClient() -- virtual method at vtable byte offset 0xa0.
	typedef int (*pfnIsNetClient)(CBaseEntity *);
	void **vtable = *(void ***)pEntity;
	pfnIsNetClient isNetClient = (pfnIsNetClient)vtable[0xa0 / sizeof(void *)];
	if (!isNetClient(pEntity))
		return;

	entvars_t *pev = CBE_pev(pEntity);
	int msg = REG_USER_MSG("ScreenFade", -1);
	MESSAGE_BEGIN(MSG_ONE, msg, NULL, pev->pContainingEntity);
	WRITE_SHORT(fade.duration);
	WRITE_SHORT(fade.holdTime);
	WRITE_SHORT(fade.fadeFlags);
	WRITE_BYTE(fade.r);
	WRITE_BYTE(fade.g);
	WRITE_BYTE(fade.b);
	WRITE_BYTE(fade.a);
	MESSAGE_END();
}

void UTIL_ScreenFadeAll(const Vector &color, float fadeTime, float holdTime, int alpha,
                        int flags)   // UTIL_ScreenFadeAll @0x57b50
{
	ScreenFade fade;
	UTIL_ScreenFadeBuild(fade, color, fadeTime, holdTime, alpha, flags);

	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *pl = UTIL_PlayerByIndex(i);
		UTIL_ScreenFadeWrite(fade, pl ? (CBaseEntity *)pl->pvPrivateData : NULL);
	}
}

void UTIL_ScreenFade(CBaseEntity *pEntity, const Vector &color, float fadeTime, float holdTime,
                     int alpha, int flags)   // UTIL_ScreenFade @0x57bd0
{
	ScreenFade fade;
	UTIL_ScreenFadeBuild(fade, color, fadeTime, holdTime, alpha, flags);
	UTIL_ScreenFadeWrite(fade, pEntity);
}

int GetPlayerIndex(const char *name)   // GetPlayerIndex @0x544c0
{
	long id = 0;
	if (strtol(name, NULL, 10) != 0)
		id = strtol(name, NULL, 10);

	for (int i = 1; i <= gpGlobals->maxClients; i++)
	{
		edict_t *pl = INDEXENT(i);
		if (!pl)
			continue;

		if (id != 0)
		{
			if (g_engfuncs.pfnGetPlayerWONId(pl) == id)
				return i;
			if (id == GETPLAYERUSERID(pl))
				return i;
		}

		if (Q_strcasestr((char *)STRING(pl->v.netname), (char *)name))
			return i;
	}
	return 0;
}

edict_t *FindPlayerByName(const char *name)   // FindPlayerByName @0x545a0
{
	int idx = GetPlayerIndex(name);
	edict_t *p = INDEXENT(idx);
	return (idx > 0) ? p : NULL;
}

void MOTDText(edict_t *player, const char *text)   // MOTDText @0x540d0
{
	if (!text || !*text)
		return;

	int total = 0;
	char *s = (char *)text;
	char line[65];

	do
	{
		if (strlen(s) < 64)
		{
			strcpy(line, s);
		}
		else
		{
			strncpy(line, s, 64);
			line[64] = 0;
		}

		total += (int)strlen(line);
		if (total < 0x1000)
			s = (char *)text + total;
		else
			*s = 0;

		MESSAGE_BEGIN(MSG_ONE, ntfMsgIdMOTD, NULL, player);
		WRITE_BYTE(*s == 0);
		WRITE_STRING(line);
		MESSAGE_END();
	}
	while (*s != 0 && total < 0x1000);
}
