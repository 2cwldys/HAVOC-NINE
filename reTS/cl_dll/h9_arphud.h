// ---- H9 ARP HUD -------------------------------------------------------------------------------------------------
// Apollo RP's HUD (the text at the left of the screen: the server's title and city, the wallet, the bank, the payday, the salary, the
// job, and the lines other plugins add) as panels on H9's purple art, for a game that says it can: a server with Apollo RP (arp_hud_panel 1)
// sends each of ARP's four HUDs to a player whose userinfo key _h9arphud is 1 in one plugin-registered user message, H9ArpHud, in place
// of the hudmessage, and every other player keeps the text HUD. cl_h9_arphud (1, saved) is 0 for the text HUD; one saved cvar for each
// panel (cl_h9_arphud_left, _top, _side, _notice) and each kind of line (_title, _wallet, _bank, _payday, _salary, _job, _status, _extra,
// and _needs for the needs) switches that part off alone; cl_h9_arphud_list prints them all. A need (hunger, thirst: the line kind
// HUDK_NEED, "<label>: <0 to 100>%") is a row with a bar, in the second HUD's panel (the top right in the stock arp.cfg), headed "Needs".
// The top panels of the left column start under the weapon bar (CHudTSWeaponBar::DrawnBottom), and the first of them is drawn smaller
// while the weapon select is open (cl_h9_arphud_shrink). What the player looks at (a property door, an NPC, a player) is a plaque in the
// notice's place: the notice HUD with a line of kind 10 to 16 is drawn as a plate of one width with its heading, fields and badges
// (cl_h9_arphud_plaque). The line kinds are listed at the top of h9_arphud.cpp and in the server's
// include\ApolloRP_HUD.inc. docs\APOLLO_RP.txt section 2 is what a player sees.
//
// A server is untrusted here: the size of a message, the number of lines and rows, how long a notice stays and how long a HUD is
// kept when nothing refreshes it are the client's own limits, whatever a message says.
#pragma once

// From CHud::Init: hooks H9ArpHud, registers the cvars above and the userinfo key _h9arphud, and adds the HUD element that keeps the
// panels in step every frame. The panels are children of the viewport (h9_vgui.cpp's way) and draw on the H9 panel art.
void H9ArpHud_Init();
