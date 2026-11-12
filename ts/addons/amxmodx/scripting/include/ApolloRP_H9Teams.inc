/*
 * ApolloRP_H9Teams.inc -- H9: the teams of Apollo RP's team play (arp_teamplay, docs\APOLLO_RP.txt, 10).
 *
 * With arp_teamplay 1 a roleplay map plays on The Specialists' team rules with three teams, and a player's team follows his job:
 *
 *   1  Middle Sea Republic  a job with the police letter (arp_police_access), the medical letter (arp_medical_access) or g      blue
 *   2  Insurrection         a job with a letter of arp_h9_insurgent_access                                                       red
 *   3  Proletarians         every other job, Unemployed included                                                                 yellow
 *
 * The numbers are the places of the teams in the map's mp_teamlist (Middle Sea Republic;Insurrection;Proletarians), so they are TS's own
 * team numbers too: jointeam 1 to 3, the order of the scoreboard's groups and, in the client, the colour of the team: the client colours a
 * team by its number (GetClientColor in cl_dll death.cpp: 1 blue, 2 red, 3 yellow, 4 green, 0 yellow, 5 and up grey), in the scoreboard, in
 * chat names, the kill feed, the name of the player aimed at and the spectator HUD. The match maps' own list has the Middle Sea Republic
 * and the Insurrectionists at 1 and 2, so the first two teams are the same slots on every H9 map. ARP_Core holds the one function that maps
 * a job's access letters to a team (H9_TeamOfAccess) and the one table of the names (g_H9TeamNames); ARP_TS puts a player on his team and
 * keeps him there.
 *
 * The players move on his job. A change of the source of the answer (a player who joins a team as a game mechanic) is a change of
 * ARP_Core's H9_PlayerTeam alone: ARP_TS asks ARP_H9_TeamOf and nothing else.
 */

#if defined _ApolloRP_H9Teams_included
	#endinput
#endif

#define _ApolloRP_H9Teams_included

#include <amxmodx>
#include <ApolloRP_H9Cfg>

// no team: team play is off or has not been found running yet on this map (ARP_H9_TeamOf answers this), or a player whose job gives him none
#define ARP_H9_TEAM_NONE 0
#define ARP_H9_TEAM_FIRST 1
#define ARP_H9_TEAM_MSR 1
#define ARP_H9_TEAM_INSURRECTION 2
#define ARP_H9_TEAM_PROLETARIAN 3
#define ARP_H9_TEAMS 3

// The team a player is on by ARP's rule: 1 Middle Sea Republic, 2 Insurrection, 3 Proletarians; 0 while arp_teamplay is 0 or team play has not been
// found running on the map (ARP_TS checks that TS reports the three teams before it moves anybody). From the access letters of his job
// (personal letters an admin gave him count as the plaque's affiliation line counts them). A bot has no job: its answer is its team field,
// which the plugin that runs it sets (tsrp_roambots: 3 a citizen, 2 an insurgent citizen, 1 a guard of the Republic once there are any), 0 when it has none.
native ARP_H9_TeamOf(id)

// The name of a team, as the map's mp_teamlist and TS's scoreboard spell it: "Middle Sea Republic", "Insurrection", "Proletarians".
// Returns how many characters were written, 0 for a number that is no team.
native ARP_H9_TeamName(team,name[],len)

// Called once whenever ARP has placed a real player on a team: the first time after he joins (oldteam 0, whether TS already had him on the team
// his job gives him or ARP has just moved him there), and after every move to another team (oldteam is the team ARP last put him on, the one he
// left). TS takes a player who changes team out of play for its respawn time and respawns him, so the forward comes while he is still waiting
// for it. Never called for a bot.
forward ARP_H9_TeamChanged(id,oldteam,newteam)

// The number the map's own mapconfig (mapconfigs\<map>.cfg, which the server runs once the map is up) gives a cvar, by the last line that sets it, as ts_matchmode reads
// mp_teamplay from it before the world spawns; def when there is no such file or it does not set the cvar.
stock h9_mapcfg_num(const name[],def)
{
	new Map[64],Path[96]
	get_mapname(Map,charsmax(Map))
	formatex(Path,charsmax(Path),"mapconfigs/%s.cfg",Map)

	new File = fopen(Path,"rt",true)
	if(!File)
		return def

	new Line[160],Key[48],Value[16],Found = def
	while(!feof(File))
	{
		Line[0] = 0
		fgets(File,Line,charsmax(Line))
		trim(Line)
		if(!Line[0] || (Line[0] == '/' && Line[1] == '/'))
			continue

		Key[0] = 0
		Value[0] = 0
		parse(Line,Key,charsmax(Key),Value,charsmax(Value))
		if(equali(Key,name) && Value[0])
			Found = str_to_num(Value)
	}
	fclose(File)

	return Found
}

// Whether the switch arp_teamplay is 1 for the map that is loading, read from the files the server runs only after the plugins' precache: arp.cfg, then
// a line in the map's own mapconfig, which has the last word. 0 when neither names it.
stock bool:h9_teams_requested()
	return h9_mapcfg_num("arp_teamplay",h9_cfg_num("arp_teamplay",0)) != 0
