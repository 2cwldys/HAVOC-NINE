// ---- H9 rally HUD: the engine's side (h9_rallyhud.h) ------------------------------------------------------------------------------------
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "entity_state.h"
#include "cl_entity.h"
#include "triangleapi.h"
#include "com_model.h"
#include "r_efx.h"
#include "dlight.h"
#include "ref_params.h"
#include "h9_rallyhud.h"
#include "h9_rallyhud_draw.h"

#include <stdio.h>
#include <string.h>

namespace
{
using namespace racehud;

const char* const SPR_DIR = "sprites/h9/rally/";
const char* const MDL_DIR = "models/h9/rally/";
const int NUMERAL_MARK = 0x52484d; // baseline.iuser1 of a numeral's tempent
const int NUMERAL_LIGHT = 7482;    // its light's key

// A file that is on disk: asked for by reading it (and giving it back), the one way the engine's file system answers without a message.
bool HaveFile(const char* path)
{
	int len = 0;
	byte* data = gEngfuncs.COM_LoadFile(path, 5, &len);
	if (!data)
		return false;
	gEngfuncs.COM_FreeFile(data);
	return true;
}

struct Sprite
{
	HSPRITE h = 0;
	struct model_s* model = nullptr;
	void Load(const char* path)
	{
		h = 0;
		model = nullptr;
		if (!HaveFile(path))
			return;
		h = SPR_Load(path);
		if (h)
			model = (struct model_s*)gEngfuncs.GetSpritePointer(h);
	}
};

Sprite s_dials, s_dials2, s_needle, s_map;
bool s_artLoaded = false;

void EnsureArt()
{
	if (s_artLoaded)
		return;
	s_artLoaded = true;
	char path[128];
	snprintf(path, sizeof(path), "%sdials.spr", SPR_DIR);
	s_dials.Load(path);
	snprintf(path, sizeof(path), "%sdials2.spr", SPR_DIR);
	s_dials2.Load(path);
	snprintf(path, sizeof(path), "%shud_needle.spr", SPR_DIR);
	s_needle.Load(path);
	s_map = Sprite();
	// the map's name from "maps/<name>.bsp" (rally_hud_radar.cpp:104-111)
	const char* level = gEngfuncs.pfnGetLevelName();
	if (level && 0 == strncmp(level, "maps/", 5))
	{
		char name[64];
		snprintf(name, sizeof(name), "%s", level + 5);
		char* dot = strrchr(name, '.');
		if (dot)
			*dot = 0;
		if (name[0])
		{
			snprintf(path, sizeof(path), "%smaps/%s.spr", SPR_DIR, name);
			s_map.Load(path);
		}
	}
}

// A textured square in the HUD's own pixels, the corners as tri.cpp and rally_hud_radar.cpp give them: bottom left, top left, top right, bottom
// right with the texture's (0,1) (0,0) (1,0) (1,1).
void Quad(struct model_s* model, const float v[4][2])
{
	static const float uv[4][2] = {{0, 1}, {0, 0}, {1, 0}, {1, 1}};
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->RenderMode(kRenderTransTexture);
	gEngfuncs.pTriAPI->SpriteTexture(model, 0);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	gEngfuncs.pTriAPI->Color4f(1, 1, 1, 1.0f);
	for (int i = 0; i < 4; i++)
	{
		gEngfuncs.pTriAPI->TexCoord2f(uv[i][0], uv[i][1]);
		gEngfuncs.pTriAPI->Vertex3f(v[i][0], v[i][1], 0);
	}
	gEngfuncs.pTriAPI->End();
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_FRONT);
}

// ---- the countdown ------------------------------------------------------------------------------------------------------------------------
float s_viewOrg[3], s_viewAng[3];
bool s_haveView = false;
CountSeq s_seq = {0, COUNT_MODELS}; // done == 4: nothing to make
bool s_seqOn = false;

struct Numeral
{
	int state = -1; // -1 not asked, 0 no file, 1 ready
	struct model_s* model = nullptr;
	int index = 0;
} s_numerals[COUNT_MODELS];

bool NumeralReady(int n)
{
	Numeral& nu = s_numerals[n - 1];
	if (nu.state < 0)
	{
		nu.state = 0;
		char path[128];
		snprintf(path, sizeof(path), "%s%s.mdl", MDL_DIR, CountModelName(n));
		if (HaveFile(path)) // never asked for a model that is not on disk
		{
			int index = 0;
			struct model_s* m = gEngfuncs.CL_LoadModel(path, &index);
			if (m && index > 0)
			{
				nu.model = m;
				nu.index = index;
				nu.state = 1;
			}
		}
	}
	return nu.state == 1;
}

// EV_CustomAnimCallback: the numeral's place by the path, and a white light about it.
void NumeralCallback(struct tempent_s* ent, float frametime, float currenttime)
{
	(void)frametime;
	if (ent->entity.baseline.iuser1 != NUMERAL_MARK)
	{
		ent->die = 0.0f;
		return;
	}
	const float elapsed = currenttime - ent->entity.baseline.fuser1;
	CountPose(elapsed, ent->entity.baseline.vuser1, ent->entity.baseline.vuser2, s_viewAng, ent->entity.origin, ent->entity.angles);
	dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocDlight(NUMERAL_LIGHT);
	if (dl)
	{
		VectorCopy(ent->entity.origin, dl->origin);
		dl->radius = COUNT_LIGHT;
		dl->color.r = 255;
		dl->color.g = 255;
		dl->color.b = 255;
		dl->die = currenttime + 0.1f;
	}
}

void MakeNumeral(int n)
{
	if (!s_haveView || !NumeralReady(n))
		return;
	float org[3], ang[3] = {s_viewAng[0], s_viewAng[1], 0};
	CountStart(s_viewOrg, s_viewAng, org);
	const float zero[3] = {0, 0, 0};
	TEMPENTITY* te = gEngfuncs.pEfxAPI->R_TempModel(org, (float*)zero, ang, COUNT_LENGTH, s_numerals[n - 1].index, TE_BOUNCE_NULL);
	if (!te)
		return;
	te->flags |= FTENT_CLIENTCUSTOM;
	te->callback = NumeralCallback;
	VectorCopy(org, te->entity.baseline.vuser1);
	VectorCopy(ang, te->entity.baseline.vuser2);
	te->entity.baseline.fuser1 = gEngfuncs.GetClientTime();
	te->entity.baseline.iuser1 = NUMERAL_MARK;
}
} // namespace

void H9RallyHud_NoteView(const struct ref_params_s* pp)
{
	if (pp == nullptr)
		return;
	for (int i = 0; i < 3; i++)
	{
		s_viewOrg[i] = pp->vieworg[i];
		s_viewAng[i] = pp->viewangles[i];
	}
	s_haveView = true;
}

void H9RallyHud_Reset()
{
	s_artLoaded = false;
	s_dials = s_dials2 = s_needle = s_map = Sprite();
	for (int i = 0; i < COUNT_MODELS; i++)
		s_numerals[i] = Numeral(); // the models are looked for again on the new map
	s_seqOn = false;
	s_seq.done = COUNT_MODELS;
	s_haveView = false;
}

bool H9RallyHud_DrawBack(bool third)
{
	EnsureArt();
	const RallyLayout l = RallyLayoutFor(ScreenWidth, ScreenHeight);
	const Sprite& d = third ? s_dials : s_dials2;
	if (d.h)
	{
		// HL Rally's hud.txt gives the picture 225 x 233 of its 256 x 256 sheet (rallyhud.cpp:974-977)
		Rect rc;
		rc.left = 0;
		rc.right = 225;
		rc.top = 0;
		rc.bottom = 233;
		SPR_Set(d.h, 255, 255, 255);
		SPR_DrawHoles(0, l.dialsX, l.dialsY, &rc);
	}
	if (s_map.model)
	{
		const float x = (float)l.mapX, y = (float)l.mapY;
		const float v[4][2] = {{x, y + 128}, {x, y}, {x + 128, y}, {x + 128, y + 128}}; // rally_hud_radar.cpp:157-175
		Quad(s_map.model, v);
	}
	return s_map.model != nullptr;
}

void H9RallyHud_DrawNeedle(float rpm)
{
	EnsureArt();
	if (!s_needle.model)
		return;
	float v[4][2];
	NeedleQuad(ScreenWidth, ScreenHeight, rpm, v);
	Quad(s_needle.model, v);
}

void H9RallyHud_CountdownStart(float clientStart)
{
	s_seq.start = clientStart;
	s_seq.done = 0;
	s_seqOn = true;
}

void H9RallyHud_CountdownThink()
{
	if (!s_seqOn)
		return;
	const int n = CountNext(s_seq, gEngfuncs.GetClientTime());
	if (n > 0)
		MakeNumeral(n);
	if (s_seq.done >= COUNT_MODELS)
		s_seqOn = false;
}
