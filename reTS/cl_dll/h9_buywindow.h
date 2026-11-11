// ---- H9 buy window ----------------------------------------------------------------------------------------------
// The loadout rework (tsm_loadoutrework 1) lets a player buy his loadout with TS's equipment menu in a window the server opens: warmup and
// ready-up before a match, the freeze before a round, and, when the server does not make loadouts final, some seconds after a respawn
// wave. That menu is the client's, and the TS client opens it by itself only for a player who is spectating and closes it again as soon
// as a player who is alive and playing has it up. A server that has the rework therefore tells the game of the window of a player who is
// alive on a side with one plugin-registered user message, H9Buy: a window is open for so many seconds (with a flag that asks for the
// menu to come up now), and the window is over. The game says it reads it with the H9 VGUI protocol in the userinfo key _h9vgui (4 or
// more). While a window is open the buy key opens the menu although the player is alive, and a menu the window put up is left up; when
// the window is over the menu goes down. cl_h9_buyauto 0 stops the menu coming up by itself (the key still works). A spectator is told
// nothing: for him the spectate wait's own menu is the one. docs\LOADOUT_REWORK.txt (section 12) is the protocol and the guide.
//
// A server is untrusted here: the length of a window, the rate of messages and the rate of menus that come up by themselves are the
// client's own limits, whatever a message says, and a window the server never closes is closed by the client.
#pragma once

// From CHud::Init: hooks H9Buy, registers cl_h9_buyauto and the command cl_h9_buywindow, and adds the HUD element that keeps the window
// in step every frame.
void H9BuyWindow_Init();

// True while a buy window is open: the buy key may put the equipment menu up for a player who is alive and playing.
bool H9BuyWindow_Open();

// True while the equipment menu now up belongs to the open window (it came up by itself, or by the buy key inside it): the weapon bar
// leaves it up and a respawn's ResetHUD leaves it alone. A menu the spectate wait opened never belongs to a window.
bool H9BuyWindow_KeepsMenu();

// From the buy key, inside an open window: puts the equipment menu up for the window.
void H9BuyWindow_OpenMenu();

// From CHudTSBuyMenu::Close, whoever closes the menu: a menu that belonged to the window no longer does.
void H9BuyWindow_MenuClosed();
// ---- end H9 buy window ------------------------------------------------------------------------------------------
