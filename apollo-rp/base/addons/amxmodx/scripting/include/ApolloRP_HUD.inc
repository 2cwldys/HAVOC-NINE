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
// with its own client cvar (cl_h9_arphud_title, _wallet, _bank, _payday, _salary, _job, _status and _extra); a line added with
// ARP_AddHudItem is HUDK_EXTRA. The text HUD every other player gets does not care.
#define HUDK_EXTRA   0   // anything a plugin adds: hunger, jail status, the zone, ...
#define HUDK_TITLE   1   // the title (the city) and the blank line after it
#define HUDK_WALLET  2
#define HUDK_BANK    3
#define HUDK_PAYDAY  4
#define HUDK_SALARY  5
#define HUDK_JOB     6
#define HUDK_STATUS  7   // the dead, loading and malfunction lines

// ARP_AddHudItem for a line of a given kind (a HUDK_ value; any other is HUDK_EXTRA)
native ARP_AddHudItemKind(id,channel,refresh,kind,const item[],{Float,Sql,Result,_}:...)

// Refreshes the HUD specified
stock ARP_RefreshHud(id,channel)
	ARP_AddHudItem(id,channel,1," ")

// Called every second, when the HUD is displayed to a user.
// HUD items can be added using ARP_AddHudItem.
forward ARP_HudDisplay(id)