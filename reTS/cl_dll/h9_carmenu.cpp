// ---- H9 rally car menu: the engine's side (h9_carmenu.h) ----------------------------------------------------------------------------------
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
#include "parsemsg.h"
#include "h9_carmenu.h"
#include "h9_rallycar.h"
#include "h9_rallymodel.h"

#include <stdio.h>
#include <string.h>

bool UTIL_FindEntityInMap(const char* name, float* origin, float* angle); // hud_spectator.cpp

namespace
{
using namespace carmenu;

const char* const SHADOW_SPRITE = "sprites/h9/rally/r_shadow.spr"; // the race effects' own shadow
const char* const FLOOR_SPRITE = "sprites/h9/rally/showroom_f.spr"; // the pool of light on the showroom's floor (our own picture)
const int SHOW_MARK = 0x434d4e; // baseline.iuser1 of the showroom car's tempent
const int SHOW_LIGHT = 7483;    // its light's key

// HL Rally falls back to the map's info_player_start, then info_player_deathmatch (80 up), when there is no info_vgui_start. Here the camera stays
// where it was in that case, so no spot is made up; flip this to have HL Rally's fallback.
const bool VGUI_FALLBACK_TO_SPAWN = false;

Session s_session;
void (*s_listener)() = nullptr;
int s_screen = 0;

// ---- files ----------------------------------------------------------------------------------------------------------------------------------
bool HaveFile(const char* path)
{
	int len = 0;
	byte* data = gEngfuncs.COM_LoadFile(path, 5, &len);
	if (!data)
		return false;
	gEngfuncs.COM_FreeFile(data);
	return true;
}

// ---- the three messages ---------------------------------------------------------------------------------------------------------------------
int MsgMoney(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 4)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_session.SetMoney(READ_LONG());
	H9CarMenu_Touch();
	return 1;
}
int MsgParts(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 4)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_session.SetParts((unsigned)READ_LONG());
	H9CarMenu_Touch();
	return 1;
}
int MsgCar(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 1)
		return 1;
	BEGIN_READ(pbuf, iSize);
	s_session.SetCar(READ_BYTE());
	H9CarMenu_Touch();
	return 1;
}

// ---- the camera's spot ----------------------------------------------------------------------------------------------------------------------
char s_spotLevel[64] = "";
bool s_spotFound = false;
float s_spotOrg[3] = {0, 0, 0}, s_spotAng[3] = {0, 0, 0};
float s_spotNextTry = 0;
float s_camOrg[3] = {0, 0, 0}, s_camAng[3] = {0, 0, 0}; // where the view is while a menu is up (the spot, or where it was)

void LoadSpot()
{
	const char* level = gEngfuncs.pfnGetLevelName();
	if (level == nullptr)
		return;
	const float now = gEngfuncs.GetClientTime();
	if (0 == strncmp(level, s_spotLevel, sizeof(s_spotLevel)))
	{
		if (s_spotFound || now < s_spotNextTry) // a map with none is asked again every two seconds: the world's entity lump may not have been there yet
			return;
	}
	snprintf(s_spotLevel, sizeof(s_spotLevel), "%s", level);
	s_spotNextTry = now + 2.0f;
	float org[3] = {0, 0, 0}, ang[3] = {0, 0, 0};
	s_spotFound = UTIL_FindEntityInMap("info_vgui_start", org, ang);
	if (!s_spotFound && VGUI_FALLBACK_TO_SPAWN)
	{
		s_spotFound = UTIL_FindEntityInMap("info_player_start", org, ang) || UTIL_FindEntityInMap("info_player_deathmatch", org, ang);
		if (s_spotFound)
			org[2] += 80.0f;
	}
	for (int i = 0; i < 3; i++)
	{
		s_spotOrg[i] = org[i];
		s_spotAng[i] = ang[i];
	}
}

// ---- the showroom car -----------------------------------------------------------------------------------------------------------------------
struct ShowModel
{
	int state = -1; // the model: -1 not asked, 0 no file, 1 ready
	int index = 0;
	struct model_s* model = nullptr;
};
struct Show
{
	bool active = false; // a car is wanted
	int cls = 0;
	float lastSeen = -100.0f; // the client time of the tempent's last callback
	Spin spin;
	float pos[3] = {0, 0, 0};
	ShowModel models[rallymodel::BRAND_COUNT]; // each brand's model, and the generic one (slot 0)
} s_show;

struct Sprite
{
	int state = -1; // -1 not asked, 0 none, 1 ready
	struct model_s* model = nullptr;
} s_shadow, s_floor;

const ShowModel* LoadShowModel(int b)
{
	ShowModel& sm = s_show.models[b];
	if (sm.state < 0)
	{
		sm.state = 0;
		const char* path = rallymodel::kBrandModel[b];
		if (HaveFile(path)) // never asked for a model that is not on disk
		{
			int index = 0;
			struct model_s* m = gEngfuncs.CL_LoadModel(path, &index);
			if (m && index > 0)
			{
				sm.index = index;
				sm.model = m;
				sm.state = 1;
			}
		}
	}
	return sm.state == 1 ? &sm : nullptr;
}

// The showroom model of a class: its brand's, else the generic one; null when neither is there.
const ShowModel* ShowModelFor(int cls)
{
	const int b = rallymodel::BrandOf(cls);
	const ShowModel* sm = LoadShowModel(b);
	if (sm == nullptr && b != rallymodel::BRAND_GENERIC)
		sm = LoadShowModel(rallymodel::BRAND_GENERIC);
	return sm;
}

struct model_s* SpriteModel(Sprite& sp, const char* path)
{
	if (sp.state < 0)
	{
		sp.state = 0;
		if (HaveFile(path))
		{
			HSPRITE h = SPR_Load(path);
			if (h)
			{
				sp.model = (struct model_s*)gEngfuncs.GetSpritePointer(h);
				sp.state = sp.model != nullptr ? 1 : 0;
			}
		}
	}
	return sp.state == 1 ? sp.model : nullptr;
}
struct model_s* ShadowModel() { return SpriteModel(s_shadow, SHADOW_SPRITE); }
struct model_s* FloorModel() { return SpriteModel(s_floor, FLOOR_SPRITE); }

bool ShowAlive()
{
	return s_show.active && gEngfuncs.GetClientTime() - s_show.lastSeen < 0.5f;
}

// EV_CustomAnimCallback: keeps the car in front of the view, turns it, sets its livery, lights it.
void ShowCallback(struct tempent_s* ent, float frametime, float currenttime)
{
	if (ent->entity.baseline.iuser1 != SHOW_MARK || !s_show.active)
	{
		ent->die = 0.0f; // not wanted (the menu closed, or a car of an older map): the engine drops it
		return;
	}
	ent->die = currenttime + 0.3f; // as HL Rally: its life is renewed each frame, so a menu that goes takes the car with it
	s_show.lastSeen = currenttime;
	SpinFrame(s_show.spin, frametime);
	ShowPlace(s_camOrg, s_camAng, s_show.pos);
	VectorCopy(s_show.pos, ent->entity.origin);
	ent->entity.angles[0] = 0;
	ent->entity.angles[1] = s_show.spin.yaw;
	ent->entity.angles[2] = 0;
	ent->entity.curstate.skin = ShowSkin(s_show.cls);
	const ShowModel* sm = ShowModelFor(s_show.cls); // the hovered class's own brand
	if (sm != nullptr && ent->entity.model != sm->model)
	{
		ent->entity.model = sm->model;
		ent->entity.curstate.modelindex = sm->index;
	}
	dlight_t* dl = gEngfuncs.pEfxAPI->CL_AllocElight(SHOW_LIGHT);
	if (dl)
	{
		VectorCopy(s_show.pos, dl->origin);
		dl->origin[0] -= 20; // above and behind to one side, as HL Rally sets it
		dl->origin[1] += 20;
		dl->origin[2] += 50;
		dl->radius = kShowLightRadius;
		dl->color.r = kShowLightR;
		dl->color.g = kShowLightG;
		dl->color.b = kShowLightB;
		dl->die = currenttime + 0.1f;
	}
}
} // namespace

void H9CarMenu_Init()
{
	gEngfuncs.pfnHookUserMsg("H9RMoney", MsgMoney);
	gEngfuncs.pfnHookUserMsg("H9RParts", MsgParts);
	gEngfuncs.pfnHookUserMsg("H9RCar", MsgCar);
}

void H9CarMenu_VidInit()
{
	s_session.Reset();
	s_spotLevel[0] = 0;
	s_spotFound = false;
	s_show = Show(); // the model's handle is asked for again on the new map
	s_shadow = Sprite();
	s_floor = Sprite();
	H9CarMenu_Touch();
}

bool H9CarMenu_RallyMode() { return H9RallyCar_ModeOn(); }
bool H9CarMenu_MenuUp() { return s_screen != 0; }
void H9CarMenu_SetScreen(int screen)
{
	s_screen = screen;
	if (screen == 0)
		H9CarMenu_ClearCar();
}
int H9CarMenu_Screen() { return s_screen; }

Session& H9CarMenu_Session() { return s_session; }
void H9CarMenu_SetListener(void (*fn)()) { s_listener = fn; }
void H9CarMenu_Touch()
{
	if (s_listener != nullptr)
		s_listener();
}

int H9CarMenu_Execute()
{
	char buf[160];
	const int n = s_session.Execute(0 != g_iUser1, buf, sizeof(buf));
	if (n > 0)
		gEngfuncs.pfnClientCmd(buf);
	H9CarMenu_Touch();
	return n;
}

void H9CarMenu_ShowCar(int cls)
{
	if (cls < 1 || cls > H9R_NUM_CARS)
		return;
	s_show.cls = cls;
	if (ShowAlive())
		return; // the car stands there: its livery follows the class by itself
	const ShowModel* first = ShowModelFor(cls);
	if (first == nullptr)
		return;
	s_show.active = true;
	s_show.lastSeen = gEngfuncs.GetClientTime();
	float org[3];
	ShowPlace(s_camOrg, s_camAng, org);
	VectorCopy(org, s_show.pos);
	const float zero[3] = {0, 0, 0};
	float ang[3] = {0, s_show.spin.yaw, 0};
	TEMPENTITY* te = gEngfuncs.pEfxAPI->R_TempModel(org, (float*)zero, ang, 999.0f, first->index, TE_BOUNCE_NULL);
	if (!te)
	{
		s_show.active = false;
		return;
	}
	te->flags |= FTENT_CLIENTCUSTOM | FTENT_PERSIST; // PERSIST: HUD_TempEntUpdate drops a tempent the engine cannot draw this frame (not in the view's PVS); the callback's die time ends this one
	te->flags &= ~(FTENT_COLLIDEWORLD | FTENT_GRAVITY); // it stands where the callback puts it
	te->callback = ShowCallback;
	te->entity.baseline.iuser1 = SHOW_MARK;
	te->entity.curstate.skin = ShowSkin(cls);
}

void H9CarMenu_ClearCar()
{
	s_show.active = false;
	s_show.spin.down = false;
}

bool H9CarMenu_HasCar() { return ShowAlive(); }

void H9CarMenu_DragBegin(int button)
{
	(void)button;
	if (ShowAlive())
		s_show.spin.down = true;
}
void H9CarMenu_DragMove(int button, int dx, int dy)
{
	if (s_show.spin.down)
		DragMove(s_show.spin, button, dx, dy);
}
void H9CarMenu_DragEnd() { s_show.spin.down = false; }

bool H9CarMenu_ApplyCamera(struct ref_params_s* pp)
{
	if (pp == nullptr || !CameraApplies(H9CarMenu_MenuUp(), pp->intermission, pp->nextView))
		return false;
	LoadSpot();
	if (!s_spotFound)
	{
		for (int i = 0; i < 3; i++)
		{
			s_camOrg[i] = pp->vieworg[i];
			s_camAng[i] = pp->viewangles[i];
		}
		return false;
	}
	for (int i = 0; i < 3; i++)
	{
		s_camOrg[i] = pp->vieworg[i] = s_spotOrg[i];
		s_camAng[i] = pp->viewangles[i] = s_spotAng[i];
	}
	Vectors(pp->viewangles, pp->forward, pp->right, pp->up);
	return true;
}

// The black room (HL Rally draws it while the main or the car menu is up, the car or none), with a sprite's texture in black as HL Rally's
// vgui_back.spr; we have no such picture, so the floor's (or the shadow's) carries it.
static const float kUV[4][2] = {{0, 0}, {0, 1}, {1, 1}, {1, 0}}; // HL Rally's order for the four corners

static void DrawRoom(struct model_s* tex)
{
	float q[5][4][3];
	RoomQuads(s_camOrg, s_camAng, q);
	gEngfuncs.pTriAPI->SpriteTexture(tex, 0);
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	for (int k = 0; k < 5; k++)
		for (int i = 0; i < 4; i++)
		{
			gEngfuncs.pTriAPI->Brightness(1);
			gEngfuncs.pTriAPI->TexCoord2f(kUV[i][0], kUV[i][1]);
			gEngfuncs.pTriAPI->Color4f(0, 0, 0, 1);
			gEngfuncs.pTriAPI->Vertex3fv(q[k][i]);
		}
	gEngfuncs.pTriAPI->End();
}

static void DrawFloor(struct model_s* tex)
{
	float c[4][3];
	FloorQuad(s_camOrg, s_camAng, c);
	gEngfuncs.pTriAPI->SpriteTexture(tex, 0);
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	for (int i = 0; i < 4; i++)
	{
		gEngfuncs.pTriAPI->Brightness(1);
		gEngfuncs.pTriAPI->TexCoord2f(kUV[i][0], kUV[i][1]);
		gEngfuncs.pTriAPI->Color4f(1, 1, 1, 1);
		gEngfuncs.pTriAPI->Vertex3fv(c[i]);
	}
	gEngfuncs.pTriAPI->End();
}

void H9CarMenu_Draw()
{
	if (s_screen == 0)
		return;
	struct model_s* floorTex = FloorModel();
	struct model_s* shadowTex = ShadowModel();
	struct model_s* roomTex = floorTex != nullptr ? floorTex : shadowTex;
	if (roomTex != nullptr)
		DrawRoom(roomTex);
	if (floorTex != nullptr && s_screen >= 2) // HL Rally's showroom mode: the car menu and the customise screen
		DrawFloor(floorTex);
	if (ShowAlive() && shadowTex != nullptr)
	{
		float c[4][3];
		ShadowCorners(s_show.pos, s_show.spin.yaw, c);
		gEngfuncs.pTriAPI->CullFace(TRI_NONE);
		gEngfuncs.pTriAPI->RenderMode(kRenderTransTexture);
		gEngfuncs.pTriAPI->SpriteTexture(shadowTex, 0);
		gEngfuncs.pTriAPI->Begin(TRI_QUADS);
		for (int i = 0; i < 4; i++)
		{
			gEngfuncs.pTriAPI->Brightness(1);
			gEngfuncs.pTriAPI->TexCoord2f(kUV[i][0], kUV[i][1]);
			gEngfuncs.pTriAPI->Color4f(1, 1, 1, 1);
			gEngfuncs.pTriAPI->Vertex3fv(c[i]);
		}
		gEngfuncs.pTriAPI->End();
	}
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_FRONT);
}
