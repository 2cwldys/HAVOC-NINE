#if defined _ApolloRP_HUD_included
	#endinput
#endif

#define _ApolloRP_HUD_included

#include <ApolloRP>

// Adds a line to a user's hud
// Do not use "^n" here, it will be replaced by the core anyway
// Note that this can only be used when ARP_HudDisplay is called (not after or before)
// Channel is a channel from the "HUD_NUM" enum
native ARP_AddHudItem(id,channel,refresh,const item[],{Float,Sql,Result,_}:...)

// What a line is. An H9 player's HUD panel (include\h9_vgui.inc, docs\APOLLO_RP.txt section 2) switches each kind on and off
// with its own client cvar (cl_h9_arphud_title, _wallet, _bank, _payday, _salary, _job, _status and _extra, and _needs for HUDK_NEED); a
// line added with ARP_AddHudItem is HUDK_EXTRA. The text HUD every other player gets does not care.
#define HUDK_EXTRA   0   // anything a plugin adds: jail status, the zone, ...
#define HUDK_TITLE   1   // the title (the city) and the blank line after it
#define HUDK_WALLET  2
#define HUDK_BANK    3
#define HUDK_PAYDAY  4
#define HUDK_SALARY  5
#define HUDK_JOB     6
#define HUDK_STATUS  7   // the dead, loading and malfunction lines
#define HUDK_NEED    8   // a need (hunger, thirst): the text is "<label>: <0 to 100>%" and the panel draws it as a bar
#define HUDK_ICON    9   // H9: the picture of an item, in the notice HUD: the text is "icon:<the item's name>"; the panel of a game at _h9vgui 7 draws
                         // its picture (sprites/h9_arpicons.spr) above the notice's box and shows no text for the line. Sent by the core alone (ARP_AddHudItemKind keeps a
                         // plugin's kind to HUDK_EXTRA to HUDK_NEED), and only to a game that draws it

// H9: the plaque, what a player looks at (a property door, an NPC, a player) as the notice HUD's lines. Sent by the core alone, like HUDK_ICON, when
// arp_h9_plaque is 1 and arp_hud4_type is 2. Each line's text reads on its own, so a game that does not know the kinds draws them as plain lines
// ("Owner: State property"); the kind says how the plaque panel draws it. A line that has a label is "<Label>: <value>".
#define HUDK_PLAQUE         10   // the heading: the establishment's, NPC's or player's name. Its presence makes the notice a plaque
#define HUDK_PLAQUE_ROW     11   // "<Label>: <value>" (Owner, Role, Job, For sale)
#define HUDK_PLAQUE_TAG     12   // "Affiliation: <name>": drawn as a badge
#define HUDK_PLAQUE_OPEN    13   // "Status: Open": the property is not locked
#define HUDK_PLAQUE_SEALED  14   // "Status: Sealed": the property is locked
#define HUDK_PLAQUE_WARN    15   // "Restricted: <who>": the viewer lacks the access the door asks for
#define HUDK_PLAQUE_HINT    16   // a hint under the rows ("Say /buy to purchase", "Press use (default e) to use")

// ARP_AddHudItem for a line of a given kind (a HUDK_ value; any other is HUDK_EXTRA)
native ARP_AddHudItemKind(id,channel,refresh,kind,const item[],{Float,Sql,Result,_}:...)

// A need's line for the second HUD (HUD_SEC, at the top right in the stock arp.cfg). An H9 player's game draws the needs of a HUD as a panel
// with the heading "Needs" and a row for each: the label, a bar and the number; every other player gets the line as text, "<label>: <value>%",
// in the place arp_hud2_x and arp_hud2_y give. Call it from a HUD_Render handler when Data[1] is HUD_SEC, for a living player whose account is
// loaded, and only while the need is switched on (ARP_HungerMod does, for "Hunger" and "Thirst"). The value is how bad the need is, 0 (satisfied) to 100:
// the bar goes from green through yellow to red at 75 and has a mark at 75 and at 90. A line under it of kind HUDK_STATUS in the same HUD (for
// instance "Starving") is drawn as a warning.
stock ARP_AddNeedItem(id,const label[],value)
	ARP_AddHudItemKind(id,HUD_SEC,0,HUDK_NEED,"%s: %d%%",label,clamp(value,0,100))

// Refreshes the HUD specified
stock ARP_RefreshHud(id,channel)
	ARP_AddHudItem(id,channel,1," ")

// Called every second, when the HUD is displayed to a user.
// HUD items can be added using ARP_AddHudItem.
forward ARP_HudDisplay(id)