// ---- H9 ARP context menu ------------------------------------------------------------------------------------------------------------------
// The menu of the use key on a player: Apollo RP's ARP_H9Ctx (docs\APOLLO_RP.txt 10, docs\ARP_INVENTORY.txt 10) sends the user message H9Ctx, a list of rows with
// the reason each cannot be chosen, and takes the commands "h9ctx pick <serial> <index>" and "h9ctx close <serial>" back. The game says it can read the message with
// the userinfo key _h9vgui at 10 (the inventory and exchange windows are 6 and up). While the menu is up the cursor is the player's, like the inventory window's: the
// look stops, a click or a number key chooses, ESC, a right click or a click outside closes it. The model, the rules of the clicks and the drawing are
// h9_arpctx_model.h and h9_arpctx_ui.h (tested without the game, tests\test_arpctx.cpp); this file is the engine's part: the message, the drawing, the mouse, the keys
// and the commands.
//
// A server is untrusted here: the message is checked and cut to the client's own limits, and commands go out at most ten a second.
#pragma once

// From CHud::Init: hooks H9Ctx, registers cl_h9_ctxmenu, cl_h9_ctxmenu_state and cl_h9_ctxmenu_test, and adds the HUD element that draws the menu.
void H9ArpCtx_Init();

// From CHud::VidInit, by name: a map starts or the video restarts, and no menu carries over. The elements that register through AddHudElem are not members of CHud, and
// CHud::VidInit does not walk their list (Think, Draw and InitHUDData are walked), so an element that has a VidInit needs a call of its own.
void H9ArpCtx_VidInit();

// True while the menu is open: the cursor is up and the clicks and the number keys are the menu's.
bool H9ArpCtx_IsUp();

// cl_h9_ctxmenu is not 0: the game says in _h9vgui that it has the menu (10), and not (9, or 5 without the inventory window).
bool H9ArpCtx_Wanted();

// From IN_MouseEvent while the cursor is up and no VGUI window owns it: the mouse buttons as the engine sees them.
void H9ArpCtx_HandleMouse(int buttons);

// From TeamFortressViewport::KeyInput, before every other key rule: true when the menu took the key (the game does not see it).
bool H9ArpCtx_KeyInput(bool down, int keynum);
// ---- end H9 ARP context menu ---------------------------------------------------------------------------------------------------------------
