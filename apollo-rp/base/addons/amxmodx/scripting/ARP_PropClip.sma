#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <ApolloRP>

// H9: ARP_PropClip -- an invisible solid box on each prop that has no collision of its own (docs\APOLLO_RP.txt, sections 10 and 12; ORIGIN.txt item 48).
//
// A ts_model (the studio-model prop of a Specialists map: a bookshelf, a couch) is spawned with a box of size 0, and the engine's player movement leaves out a solid with no size,
// so players and bots walk through it. Each line of the map's configs\arp\maps\<map>\propclip.ini puts one box where a prop stands (docs\APOLLO_RP.txt, 12 gives the syntax):
//
//   box "x1 y1 z1" "x2 y2 z2" "<model>" "<ox oy oz>" "<ax ay az>"
//
// the world box, the prop's model, and the prop's origin and angles. The box is an info_target (renamed arp_propclip) with SOLID_BBOX and MOVETYPE_NONE that carries the prop's own
// model at the prop's own origin and angles. The model is needed, not for looks: the engine puts an entity into a player's movement only when it has a model (sv_pmove.c,
// SV_CopyEdictToPhysEnt), and a model that the map already precached is one that is loaded. It is not drawn (render mode texture, amount 0: both renderers skip it) but it is
// sent to the clients with its box, so that their own movement stops at the box as the server's does. It has no think, no touch and no sound. A trace with a size (a player, a bot, a
// monster) meets the box; a point-sized trace (a bullet) is clipped by the hitboxes of the model, one box the size of the drawn prop for a shelf or a bookcase.
//
// The tool that makes the lines is tools\propclip_tool.py: it works out the box from the vertices the model draws and the prop's angles, never from the header of the model
// (the header's box is 0 in the models of these maps). A line whose model no ts_model of the map uses is left out and logged: the models the props use are noted at plugin_init,
// before h9_staticprops, which frees ts_model entities at plugin_cfg, could take them.
//
// arp_h9_propclip 0 (the plugin's own default; arp.cfg ships 1) is stock Apollo RP: the file is not read and no entity is made. The switch is looked at every second, so that arp.cfg,
// which the server runs after plugin_init, is seen, and so that a change needs no restart: 1 reads the file and makes the boxes, 0 removes them. A box is made not solid and
// becomes solid on the first look when no player's hull is in it, so a player standing there is never trapped. The boxes are removed at the end of the map and when the plugin is
// paused. A map with no propclip.ini of its own (no fallback to configs\arp\propclip.ini) has none.

#define PC_MAX      128         // boxes one file may hold
#define PC_MODELS   128         // different models of the map's props that are noted
#define PC_CLASS    "arp_propclip"
#define PC_BEAT     1.0         // seconds between the looks at the switch and at the boxes that wait for a player to leave them
#define PC_TASK     7748
#define PC_GRACE    2.0         // units added to a player's hull when a box is tested for someone standing in it
#define PC_LINE     255
#define PC_LIMIT    16384.0     // the largest coordinate a box may have

new g_Cvar
new bool:g_Built                // the file has been read for this switch-on
new g_Num                       // boxes in the arrays below
new g_Ent[PC_MAX]               // the entity of each box, 0 for none
new bool:g_Done[PC_MAX]         // the box is solid (or given up)
new g_Line[PC_MAX]              // the line of the file a box came from
new Float:g_Min[PC_MAX][3]      // the world box
new Float:g_Max[PC_MAX][3]
new Float:g_Org[PC_MAX][3]      // the prop's origin and angles
new Float:g_Ang[PC_MAX][3]
new g_Model[PC_MAX][64]
new g_Used[PC_MODELS][64]       // the models the map's ts_model props use, as they were at plugin_init
new g_UsedNum

public ARP_Init()
	ARP_RegisterPlugin("PropClip",ARP_VERSION,"H9","Puts an invisible solid box on props that have no collision of their own (propclip.ini)")

public ARP_Error(const Reason[])
	pause("d")

public plugin_init()
{
	g_Cvar = register_cvar("arp_h9_propclip","0")

	PcNoteModels()

	// AMX Mod X's cvar hooks do not fire in this build: the switch is looked at, as the property tax looks at its own
	set_task(PC_BEAT,"PcBeat",PC_TASK,_,_,"b")
}

public plugin_end()
	PcRemove()

public plugin_pause()
	PcRemove()

// ---------------------------------------------------------------------------------------------------------------------- the switch

public PcBeat()
{
	new bool:On = get_pcvar_num(g_Cvar) > 0

	if(On && !g_Built)
		PcBuild()
	else if(!On && g_Built)
	{
		new Count = PcRemove()

		if(Count)
			log_amx("[PROPCLIP] arp_h9_propclip is 0: %d box%s removed.",Count,Count == 1 ? "" : "es")
	}

	if(g_Built)
		PcArm()
}

// the distinct models of the map's ts_model props: a box line may name only one of them, which is precached and loaded
PcNoteModels()
{
	new Ent,Model[64],Count

	g_UsedNum = 0

	while((Ent = engfunc(EngFunc_FindEntityByString,Ent,"classname","ts_model")) > 0)
	{
		pev(Ent,pev_model,Model,charsmax(Model))
		if(!Model[0])
			continue

		for(Count = 0;Count < g_UsedNum;Count++)
			if(equali(g_Used[Count],Model))
				break

		if(Count == g_UsedNum && g_UsedNum < PC_MODELS)
			copy(g_Used[g_UsedNum++],63,Model)
	}
}

bool:PcModelUsed(const Model[])
{
	for(new Count;Count < g_UsedNum;Count++)
		if(equali(g_Used[Count],Model))
			return true

	return false
}

// ---------------------------------------------------------------------------------------------------------------------- the file

// reads propclip.ini of this map and makes a box, not yet solid, for each good line
PcBuild()
{
	g_Built = true
	g_Num = 0

	new MapName[33],Dir[128],Path[192]
	get_mapname(MapName,charsmax(MapName))
	get_configsdir(Dir,charsmax(Dir))
	format(Path,charsmax(Path),"%s/arp/maps/%s/propclip.ini",Dir,MapName)

	// ARP_FileOpen falls back to configs\arp\propclip.ini for a map with no file of its own; coordinates belong to one map
	if(!file_exists(Path))
		return

	new File = ARP_FileOpen("propclip.ini","r")
	if(!File)
		return

	new Line[PC_LINE + 1],Kind[8],S1[64],S2[64],S4[64],S5[64],Model[64],LineNo,Skipped,Float:C1[3],Float:C2[3],Float:Org[3],Float:Ang[3]

	while(!feof(File))
	{
		fgets(File,Line,PC_LINE)
		LineNo++
		trim(Line)

		if(!Line[0] || Line[0] == ';')
			continue

		if(parse(Line,Kind,7,S1,63,S2,63,Model,63,S4,63,S5,63) < 6 || !equali(Kind,"box"))
		{
			log_amx("[PROPCLIP] propclip.ini line %d is not a box line (box ^"x1 y1 z1^" ^"x2 y2 z2^" ^"model^" ^"ox oy oz^" ^"ax ay az^"): left out.",LineNo)
			Skipped++

			continue
		}

		if(!PcVec(S1,C1) || !PcVec(S2,C2) || !PcVec(S4,Org) || !PcVec(S5,Ang))
		{
			log_amx("[PROPCLIP] propclip.ini line %d has a value that is not three numbers: left out.",LineNo)
			Skipped++

			continue
		}

		if(g_Num >= PC_MAX)
		{
			log_amx("[PROPCLIP] propclip.ini line %d: more than %d boxes: the rest are left out.",LineNo,PC_MAX)
			Skipped++

			break
		}

		if(!PcModelUsed(Model))
		{
			log_amx("[PROPCLIP] propclip.ini line %d: no prop of this map uses the model %s: left out.",LineNo,Model)
			Skipped++

			continue
		}

		for(new Axis;Axis < 3;Axis++)
		{
			g_Min[g_Num][Axis] = floatmin(C1[Axis],C2[Axis])
			g_Max[g_Num][Axis] = floatmax(C1[Axis],C2[Axis])
		}

		if(g_Max[g_Num][0] - g_Min[g_Num][0] < 1.0 || g_Max[g_Num][1] - g_Min[g_Num][1] < 1.0 || g_Max[g_Num][2] - g_Min[g_Num][2] < 1.0
		|| floatabs(g_Min[g_Num][0]) > PC_LIMIT || floatabs(g_Min[g_Num][1]) > PC_LIMIT || floatabs(g_Min[g_Num][2]) > PC_LIMIT
		|| floatabs(g_Max[g_Num][0]) > PC_LIMIT || floatabs(g_Max[g_Num][1]) > PC_LIMIT || floatabs(g_Max[g_Num][2]) > PC_LIMIT)
		{
			log_amx("[PROPCLIP] propclip.ini line %d: the box is empty or outside the map: left out.",LineNo)
			Skipped++

			continue
		}

		g_Org[g_Num] = Org
		g_Ang[g_Num] = Ang
		copy(g_Model[g_Num],63,Model)
		g_Line[g_Num] = LineNo

		g_Ent[g_Num] = PcMake(g_Num)
		if(!g_Ent[g_Num])
		{
			log_amx("[PROPCLIP] propclip.ini line %d: no entity could be made for the box: left out.",LineNo)
			Skipped++

			continue
		}

		g_Done[g_Num] = false
		g_Num++
	}

	fclose(File)

	log_amx("[PROPCLIP] %s: %d box%s made from propclip.ini, %d line%s left out.",MapName,g_Num,g_Num == 1 ? "" : "es",Skipped,Skipped == 1 ? "" : "s")
}

// three numbers in a text, "x y z"
bool:PcVec(const Text[],Float:Vec[3])
{
	new A[24],B[24],C[24]

	if(parse(Text,A,23,B,23,C,23) < 3 || !PcNumber(A) || !PcNumber(B) || !PcNumber(C))
		return false

	Vec[0] = str_to_float(A)
	Vec[1] = str_to_float(B)
	Vec[2] = str_to_float(C)

	return true
}

bool:PcNumber(const Text[])
	return (Text[0] >= '0' && Text[0] <= '9') || ((Text[0] == '-' || Text[0] == '+' || Text[0] == '.') && Text[1] != 0)

// ---------------------------------------------------------------------------------------------------------------------- the boxes

// the entity of box Index: not solid yet, the prop's model at the prop's origin and angles, invisible, with the box's size relative to the origin
PcMake(Index)
{
	new Ent = engfunc(EngFunc_CreateNamedEntity,engfunc(EngFunc_AllocString,"info_target"))

	if(!pev_valid(Ent))
		return 0

	set_pev(Ent,pev_classname,PC_CLASS)
	engfunc(EngFunc_SetModel,Ent,g_Model[Index])

	if(!pev(Ent,pev_modelindex))
	{
		engfunc(EngFunc_RemoveEntity,Ent)

		return 0
	}

	new Float:Mins[3],Float:Maxs[3]

	for(new Axis;Axis < 3;Axis++)
	{
		Mins[Axis] = g_Min[Index][Axis] - g_Org[Index][Axis]
		Maxs[Axis] = g_Max[Index][Axis] - g_Org[Index][Axis]
	}

	set_pev(Ent,pev_movetype,MOVETYPE_NONE)
	set_pev(Ent,pev_solid,SOLID_NOT)
	set_pev(Ent,pev_effects,0)
	set_pev(Ent,pev_rendermode,kRenderTransTexture)
	set_pev(Ent,pev_renderamt,0.0)
	set_pev(Ent,pev_angles,g_Ang[Index])
	engfunc(EngFunc_SetOrigin,Ent,g_Org[Index])
	engfunc(EngFunc_SetSize,Ent,Mins,Maxs)

	return Ent
}

bool:PcOurs(Ent)
{
	if(Ent < 1 || !pev_valid(Ent))
		return false

	new Classname[24]
	pev(Ent,pev_classname,Classname,charsmax(Classname))

	return equal(Classname,PC_CLASS) != 0
}

// every box that nobody stands in becomes solid; one that someone stands in waits for the next look
PcArm()
{
	for(new Index;Index < g_Num;Index++)
	{
		if(g_Done[Index])
			continue

		if(!PcOurs(g_Ent[Index]))
		{
			g_Ent[Index] = 0
			g_Done[Index] = true

			log_amx("[PROPCLIP] the entity of the box of line %d is gone.",g_Line[Index])

			continue
		}

		if(PcPlayerIn(Index))
			continue

		set_pev(g_Ent[Index],pev_solid,SOLID_BBOX)
		engfunc(EngFunc_SetOrigin,g_Ent[Index],g_Org[Index])
		g_Done[Index] = true
	}
}

// a player (or a bot) whose hull, a little wider than it is, meets the box
bool:PcPlayerIn(Index)
{
	new Float:Org[3],Float:Mins[3],Float:Maxs[3]

	for(new Id = 1;Id <= get_maxplayers();Id++)
	{
		if(!is_user_alive(Id))
			continue

		pev(Id,pev_origin,Org)
		pev(Id,pev_mins,Mins)
		pev(Id,pev_maxs,Maxs)

		if(Org[0] + Maxs[0] + PC_GRACE > g_Min[Index][0] && Org[0] + Mins[0] - PC_GRACE < g_Max[Index][0]
		&& Org[1] + Maxs[1] + PC_GRACE > g_Min[Index][1] && Org[1] + Mins[1] - PC_GRACE < g_Max[Index][1]
		&& Org[2] + Maxs[2] + PC_GRACE > g_Min[Index][2] && Org[2] + Mins[2] - PC_GRACE < g_Max[Index][2])
			return true
	}

	return false
}

// removes every box this plugin made and any strays of its class; the number removed
PcRemove()
{
	new Count,Ent

	for(new Index;Index < g_Num;Index++)
	{
		if(PcOurs(g_Ent[Index]))
		{
			engfunc(EngFunc_RemoveEntity,g_Ent[Index])
			Count++
		}

		g_Ent[Index] = 0
		g_Done[Index] = false
	}

	while((Ent = engfunc(EngFunc_FindEntityByString,Ent,"classname",PC_CLASS)) > 0)
	{
		engfunc(EngFunc_RemoveEntity,Ent)
		Count++
	}

	g_Num = 0
	g_Built = false

	return Count
}
