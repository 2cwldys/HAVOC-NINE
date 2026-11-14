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

#include <stdio.h>
#include <string.h>

bool UTIL_FindEntityInMap(const char* name, float* origin, float* angle); // hud_spectator.cpp

namespace
{
using namespace carmenu;

const char* const CAR_MODEL = "models/h9/rc_rally_xs.mdl"; // the one car model there is: every class shows it, by livery
const char* const SHADOW_SPRITE = "sprites/h9/rally/r_shadow.spr"; // the race effects' own shadow
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
struct Show
{
	bool active = false; // a car is wanted
	int cls = 0;
	float lastSeen = -100.0f; // the client time of the tempent's last callback
	Spin spin;
	float pos[3] = {0, 0, 0};
	int state = -1; // the model: -1 not asked, 0 no file, 1 ready
	int index = 0;
} s_show;

struct Sprite
{
	int state = -1; // -1 not asked, 0 none, 1 ready
	struct model_s* model = nullptr;
} s_shadow;

bool CarModelReady()
{
	if (s_show.state < 0)
	{
		s_show.state = 0;
		if (HaveFile(CAR_MODEL)) // never asked for a model that is not on disk
		{
			int index = 0;
			struct model_s* m = gEngfuncs.CL_LoadModel(CAR_MODEL, &index);
			if (m && index > 0)
			{
				s_show.index = index;
				s_show.state = 1;
			}
		}
	}
	return s_show.state == 1;
}

struct model_s* ShadowModel()
{
	if (s_shadow.state < 0)
	{
		s_shadow.state = 0;
		if (HaveFile(SHADOW_SPRITE))
		{
			HSPRITE h = SPR_Load(SHADOW_SPRITE);
			if (h)
			{
				s_shadow.model = (struct model_s*)gEngfuncs.GetSpritePointer(h);
				s_shadow.state = s_shadow.model != nullptr ? 1 : 0;
			}
		}
	}
	return s_shadow.state == 1 ? s_shadow.model : nullptr;
}

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
	if (!CarModelReady())
		return;
	s_show.active = true;
	s_show.lastSeen = gEngfuncs.GetClientTime();
	float org[3];
	ShowPlace(s_camOrg, s_camAng, org);
	VectorCopy(org, s_show.pos);
	const float zero[3] = {0, 0, 0};
	float ang[3] = {0, s_show.spin.yaw, 0};
	TEMPENTITY* te = gEngfuncs.pEfxAPI->R_TempModel(org, (float*)zero, ang, 999.0f, s_show.index, TE_BOUNCE_NULL);
	if (!te)
	{
		s_show.active = false;
		return;
	}
	te->flags |= FTENT_CLIENTCUSTOM;
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
	if (pp == nullptr || !H9CarMenu_MenuUp())
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

void H9CarMenu_Draw()
{
	if (!ShowAlive() || s_screen == 0)
		return;
	struct model_s* spr = ShadowModel();
	if (spr == nullptr)
		return;
	float c[4][3];
	ShadowCorners(s_show.pos, s_show.spin.yaw, c);
	static const float uv[4][2] = {{0, 0}, {0, 1}, {1, 1}, {1, 0}}; // HL Rally's order for the four corners
	gEngfuncs.pTriAPI->CullFace(TRI_NONE);
	gEngfuncs.pTriAPI->RenderMode(kRenderTransTexture);
	gEngfuncs.pTriAPI->SpriteTexture(spr, 0);
	gEngfuncs.pTriAPI->Begin(TRI_QUADS);
	for (int i = 0; i < 4; i++)
	{
		gEngfuncs.pTriAPI->Brightness(1);
		gEngfuncs.pTriAPI->TexCoord2f(uv[i][0], uv[i][1]);
		gEngfuncs.pTriAPI->Color4f(1, 1, 1, 1);
		gEngfuncs.pTriAPI->Vertex3fv(c[i]);
	}
	gEngfuncs.pTriAPI->End();
	gEngfuncs.pTriAPI->RenderMode(kRenderNormal);
	gEngfuncs.pTriAPI->CullFace(TRI_FRONT);
}
