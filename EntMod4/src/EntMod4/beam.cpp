#include "plugin.h"
#include <customentity.h>

// EntMod4 -- reconstructed: the CBeam effect helpers (original beam.cpp, @0x46a70-0x46f60).
// EntMod ported Valve's CBeam (hlsdk effects.cpp) to free functions that take the beam's entvars_t*
// directly instead of a CBeam this-pointer, so the entity tools can drive a beam entity without a
// gamedll class. Field use matches the stock CBeam: type+flags packed in rendermode, start entity in
// sequence, end entity in skin, start point in origin, end point in angles, owner/aiment cache the
// endpoint edicts, body = noise, animtime = scroll rate, scale = width, modelindex = sprite texture.

// CBeam::SetStartEntity -- start index in the low 12 bits of sequence; cache the edict in owner.
void SetStartEntity(int entindex, entvars_t *pev)   // SetStartEntity @0x46a70
{
	pev->sequence = (entindex & 0x0FFF) | ((pev->sequence & 0xF000) << 12);
	pev->owner = INDEXENT(entindex);
}

// CBeam::SetEndEntity -- end index in the low 12 bits of skin; cache the edict in aiment.
void SetEndEntity(int entindex, entvars_t *pev)     // SetEndEntity @0x46ab0
{
	pev->skin = (entindex & 0x0FFF) | ((pev->skin & 0xF000) << 12);
	pev->aiment = INDEXENT(entindex);
}

// CBeam::GetStartPos -- for a BEAM_ENTS beam the start follows the start entity; otherwise origin.
float *GetStartPos(entvars_t *pev)                  // GetStartPos @0x46af0
{
	if ((pev->rendermode & 0x0F) == BEAM_ENTS)
	{
		edict_t *pent = INDEXENT(pev->sequence & 0x0FFF);
		return pent->v.origin;
	}
	return pev->origin;
}

// CBeam::GetEndPos -- point/hose beams store the end in angles; entity beams follow the end entity.
float *GetEndPos(entvars_t *pev)                    // GetEndPos @0x46b30
{
	int type = pev->rendermode & 0x0F;
	if (type == BEAM_POINTS || type == BEAM_HOSE)
		return pev->angles;

	edict_t *pent = INDEXENT(pev->skin & 0x0FFF);
	if (pent != NULL)
		return pent->v.origin;
	return pev->angles;
}

// CBeam::BeamInit -- white, full-bright custom entity bound to the given sprite and width.
void BeamInit(const char *sprite, int width, entvars_t *pev)   // BeamInit @0x46b80
{
	pev->flags |= FL_CUSTOMENTITY;
	pev->rendercolor.x = 255.0f;   // SetColor
	pev->rendercolor.y = 255.0f;
	pev->rendercolor.z = 255.0f;
	pev->renderamt = 255.0f;       // SetBrightness
	pev->body = 0;                 // SetNoise
	pev->frame = 0;                // SetFrame
	pev->animtime = 0;             // SetScrollRate
	pev->model = MAKE_STRING(sprite);
	pev->modelindex = PRECACHE_MODEL((char *)sprite);   // SetTexture
	pev->scale = (float)width;     // SetWidth
	pev->skin = 0;
	pev->sequence = 0;
	pev->rendermode = 0;
}

// CBeam::BeamCreate -- spawn a "beam" entity and initialize it; EntMod uses CREATE_NAMED_ENTITY.
edict_t *BeamCreate(const char *sprite, int width)  // BeamCreate @0x46c20
{
	edict_t *pBeam = CREATE_NAMED_ENTITY(MAKE_STRING("beam"));
	pBeam->v.classname = MAKE_STRING("beam");
	BeamInit(sprite, width, &pBeam->v);
	return pBeam;
}

// CBeam::RelinkBeam -- rebuild the beam's bounding box from its start and end points.
void RelinkBeam(entvars_t *pev)                     // RelinkBeam @0x46c90
{
	float *startPos = GetStartPos(pev);
	float *endPos = GetEndPos(pev);

	pev->mins.x = (startPos[0] < endPos[0]) ? startPos[0] : endPos[0];
	pev->mins.y = (startPos[1] < endPos[1]) ? startPos[1] : endPos[1];
	pev->mins.z = (startPos[2] < endPos[2]) ? startPos[2] : endPos[2];
	pev->maxs.x = (startPos[0] > endPos[0]) ? startPos[0] : endPos[0];
	pev->maxs.y = (startPos[1] > endPos[1]) ? startPos[1] : endPos[1];
	pev->maxs.z = (startPos[2] > endPos[2]) ? startPos[2] : endPos[2];
	pev->mins = pev->mins - pev->origin;
	pev->maxs = pev->maxs - pev->origin;

	UTIL_SetSize(pev, pev->mins, pev->maxs);
	UTIL_SetOrigin(pev, pev->origin);
}

// CBeam::EntsInit -- a beam strung between two entities.
void EntsInit(int startIndex, int endIndex, entvars_t *pev)    // EntsInit @0x46db0
{
	pev->rendermode = (pev->rendermode & 0xF0) | BEAM_ENTS;    // SetType
	SetStartEntity(startIndex, pev);
	SetEndEntity(endIndex, pev);
	RelinkBeam(pev);
}

// CBeam::PointEntInit -- a beam from a fixed point to an entity.
void PointEntInit(const Vector &start, int endIndex, entvars_t *pev)   // PointEntInit @0x46e60
{
	pev->rendermode = (pev->rendermode & 0xF0) | BEAM_ENTPOINT;   // SetType
	pev->origin = start;          // SetStartPos
	SetEndEntity(endIndex, pev);
	RelinkBeam(pev);
}

// CBeam::HoseInit -- a hose beam: a start point and a direction stored in angles.
void HoseInit(const Vector &start, const Vector &end, entvars_t *pev)  // HoseInit @0x46ef0
{
	pev->rendermode = (pev->rendermode & 0xF0) | BEAM_HOSE;   // SetType
	pev->origin = start;          // SetStartPos
	pev->angles = end;            // SetEndPos
	RelinkBeam(pev);
}

// CBeam::PointsInit -- a beam between two fixed points, with no entity endpoints.
void PointsInit(const Vector &start, const Vector &end, entvars_t *pev)   // PointsInit @0x46f60
{
	pev->rendermode = (pev->rendermode & 0xF0) | BEAM_POINTS;   // SetType
	pev->origin = start;          // SetStartPos
	pev->angles = end;            // SetEndPos
	SetStartEntity(0, pev);
	SetEndEntity(0, pev);
	RelinkBeam(pev);
}
