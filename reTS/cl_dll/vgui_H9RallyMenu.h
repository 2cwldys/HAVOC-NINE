// ---- H9 rally menus: the main menu, the car menu and Customise, as VGUI1 panels (vgui_H9RallyMenu.cpp) -----------------------------------
// In rally mode (physinfo "rally" above 0) ShowVGUIMenu gives MENU_INTRO the main menu, MENU_TEAM the car menu and MENU_CLASS Customise, in the
// place of the stock MOTD window, team menu and class menu; outside rally mode the stock ones are used and nothing here is made.
#pragma once

class CMenuPanel;

// The panel for a menu id (MENU_INTRO, MENU_TEAM, MENU_CLASS), made on first use and kept; NULL for any other id.
CMenuPanel* H9RallyMenu_Get(int iMenu);
