// ---- H9 ARP inventory and exchange ---------------------------------------------------------------------------------------------
// Apollo RP's inventory as a window the player clicks and drags, the exchange of goods between two players, and the search of a handcuffed
// player. The server (ARP_Inventory, docs\APOLLO_RP.txt) sends three plugin-registered user messages, H9Inv, H9Trade and H9Search, and takes
// the commands "h9inv ..." back; the game says it can read them with the userinfo key _h9vgui at 6 or more (H9Search: 8). While the window is open the cursor is the player's, like the buy menu's:
// it stays until the player closes the window with its X, with ESC or with the key bound to cl_h9_inventory. The model and the rules of the
// clicks are h9_arpinv_model.h and h9_arpinv_ui.h (tested without the game, tests\test_arpinv.cpp); this file is the engine's part: the
// messages, the drawing, the mouse and the keys.
//
// A server is untrusted here: the messages are checked and cut to the client's own limits, commands go out at most ten a second, and the
// client asks for nothing the server did not say it has.
#pragma once

// From CHud::Init: hooks H9Inv and H9Trade, registers cl_h9_arpinv, cl_h9_inventory, cl_h9_arpinv_state and cl_h9_arpinv_test, and adds the HUD element
// that draws the window.
void H9ArpInv_Init();

// From CHud::VidInit, by name: a map starts or the video restarts. The window and the catalog of the last map are forgotten and the item pictures
// (sprites/h9_arpicons.spr and .txt) are read again, as every client sprite is. The elements that register through AddHudElem are not members of CHud,
// and CHud::VidInit does not walk their list (Think, Draw and InitHUDData are walked), so an element that has a VidInit needs a call of its own.
void H9ArpInv_VidInit();

// True while the inventory window is open: the cursor is up and the clicks are the window's.
bool H9ArpInv_IsUp();

// cl_h9_arpinv is not 0: the game says in _h9vgui that it has the window (6) and not (5).
bool H9ArpInv_Wanted();

// From the context menu (h9_arpctx.cpp), which stands over the window and takes the buttons while it is up: the buttons as they are when the menu goes, so that one held then
// is no click on the window.
void H9ArpInv_SyncMouse(int buttons);

// From IN_MouseEvent while the cursor is up and no VGUI window owns it: the mouse buttons as the engine sees them.
void H9ArpInv_HandleMouse(int buttons);

// From TeamFortressViewport::KeyInput, before every other key rule: true when the window took the key (the game does not see it).
bool H9ArpInv_KeyInput(bool down, int keynum);
// ---- end H9 ARP inventory -------------------------------------------------------------------------------------------------------
