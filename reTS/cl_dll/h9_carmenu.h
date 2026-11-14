// ---- H9 rally car menu: the engine's side (the arithmetic is h9_carmenu_calc.h, the panels vgui_H9RallyMenu.cpp) ----------------------------
// What this file does: takes the three messages of the car menu and shop (H9RMoney, H9RParts, H9RCar; pm_shared/h9_rally_shop.h is the contract),
// keeps what they say and what the player has picked, sends the commands when he presses Race, holds the camera at the map's info_vgui_start while
// the menu is up, and draws the showroom car: a temporary entity of models/h9/rc_rally_xs.mdl 65 units ahead of the view, spinning, lit by a small
// light, with a shadow under it (sprites/h9/rally/r_shadow.spr, the one the race effects use). None of it is loaded or asked for when its file is not
// on disk, and outside rally mode nothing here does anything.
#pragma once

#include "h9_carmenu_calc.h"

struct ref_params_s;

// From CHud::Init: hooks the three messages.
void H9CarMenu_Init();
// A new map or a video restart: nothing is known of the player's car, money or parts; the camera's spot is looked for again; the showroom goes.
void H9CarMenu_VidInit();

// Rally mode is on for the local player (the physinfo key "rally"); the menus are the rally ones only then.
bool H9CarMenu_RallyMode();
// One of the rally menus (main, car, customise) is the one on screen.
bool H9CarMenu_MenuUp();
// The panels say which they are while open (1 main, 2 car, 3 customise) and 0 when they close.
void H9CarMenu_SetScreen(int screen);
int H9CarMenu_Screen();

// What the player knows and has picked; the panels read and change it.
carmenu::Session& H9CarMenu_Session();
// Something changed (a message, a pick, a purchase): the panel on screen is told so that it draws it. A panel sets itself as the listener while
// it is open and clears it when it closes.
void H9CarMenu_SetListener(void (*fn)());
void H9CarMenu_Touch();

// Race: sends what is queued (changecar, buy), as HL Rally does when its Race button is pressed. Returns the commands' length.
int H9CarMenu_Execute();

// The showroom car for a class (1..10), or none. Drag: the mouse holding it (button 1 left, 2 right).
void H9CarMenu_ShowCar(int cls);
void H9CarMenu_ClearCar();
bool H9CarMenu_HasCar();
void H9CarMenu_DragBegin(int button);
void H9CarMenu_DragMove(int button, int dx, int dy);
void H9CarMenu_DragEnd();

// From V_CalcRefdef, after the rally camera: while a rally menu is up, the map's info_vgui_start is the view (and is where the showroom stands).
// With no such entity the view stays where it is. Returns true when it moved the view.
bool H9CarMenu_ApplyCamera(struct ref_params_s* pparams);

// From HUD_DrawTransparentTriangles: the showroom car's shadow.
void H9CarMenu_Draw();
