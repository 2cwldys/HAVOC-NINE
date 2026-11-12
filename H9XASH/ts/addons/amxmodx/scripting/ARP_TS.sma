#include <amxmodx>
#include <amxmisc>
#include <ApolloRP>
#include <engine>
#include <fakemeta>
#include <tsx>
#include <tsfun>
#include <sqlx>
#include <ApolloRP_VGui>
#include <ApolloRP_H9Teams>

new g_9Parabellum
new g_12Gauge
new g_556NATO
new g_45ACP
new g_50AE
new g_762Soviet
new g_57FN
new g_50BMG
new g_10Auto
new g_22Hornet
new g_454Casull
new g_32ACP
new g_762NATO

new g_AttachMenu[] = "ARP_AttachMenu"

new g_Keys = MENU_KEY_0|MENU_KEY_1|MENU_KEY_2|MENU_KEY_3|MENU_KEY_4|MENU_KEY_5|MENU_KEY_6|MENU_KEY_7|MENU_KEY_8|MENU_KEY_9

new g_Attachments[MAX_PLAYERS + 1]
new g_Gun[MAX_PLAYERS + 1]
new g_Cell[MAX_PLAYERS + 1]

enum WEAPON
{
	ITEMID = 0,
	ATTACHMENTS
}

new g_GunStats[TS_MAX_WEAPONS][WEAPON] = 
{
	{0,0},
	{50,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SILENCER},
	{0,0},
	{51,TSA_SILENCER},
	{52,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE},
	{53,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{54,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE},
	{55,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{56,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SILENCER},
	{57,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SILENCER},
	{0,0},
	{58,TSA_FLASHLIGHT|TSA_LASERSIGHT},
	{59,TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{60,TSA_SCOPE},
	{61,TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{62,TSA_LASERSIGHT|TSA_SILENCER},
	{0,0},
	{63,TSA_LASERSIGHT|TSA_SILENCER},
	{64,TSA_LASERSIGHT},
	{65,TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{66,TSA_FLASHLIGHT|TSA_LASERSIGHT},
	{67,0},
	{68,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SILENCER},
	{69,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE|TSA_SILENCER},
	{70,0},
	{71,0},
	{72,TSA_FLASHLIGHT|TSA_LASERSIGHT},
	{73,TSA_FLASHLIGHT|TSA_LASERSIGHT|TSA_SCOPE},
	{74,TSA_LASERSIGHT},
	{0,0},
	{0,0},
	{75,TSA_LASERSIGHT|TSA_SCOPE},
	{76,0},
	{77,TSA_LASERSIGHT},
	{78,0},
	{79,0},
	// H9: 36 the Contender, 37 the akimbo Skorpions, 38 the throwing knife (H9's TSX, tsconst.inc)
	{80,TSA_LASERSIGHT|TSA_SCOPE},
	{0,0},
	{0,0},
	// H9: 39 the PPSh-41 and 40 the laser rifle (H9's reTS): no attachments, so the item gives the gun at once
	{0,0},
	{0,0}
}

new g_WeaponAmmo[TS_MAX_WEAPONS] =
{
	0,//"kungfu" (H9: 0 in H9's TSX)
	210,//"glock18",
	// H9: 2 is the Beretta 92F (TSW_BERETTA), on 9mm Parabellum as the akimbo pair
	210,//"beretta",
	210,//"uzi",
	60,//"m3",
	90,//"m4a1",
	210,//"mp5sd",
	210,//"mp5k",
	210,//"aberettas",
	175,//"mk23",
	175,//"amk23",
	60,//"usas",
	70,//"deagle",
	90,//"ak47",
	200,//"57",
	90,//"aug",
	210,//"auzi",
	300,//"skorpion",
	30,//"m82a1",
	200,//"mp7",
	60,//"spas",
	200,//"gcolts",
	100,//"glock20",
	175,//"ump",
	0,//"m61grenade",
	0,//"cknife",
	60,//"mossberg",
	90,//"m16a4",
	150,//"mk1",
	0,//"c4",
	200,//"a57",
	50,//"rbull",
	90,//"m60e3",
	60,//"sawed_off",
	0,//"katana",
	0,//"sknife",
	35,//"contender" (H9: 36)
	300,//"askorpion" (H9: 37, the akimbo Skorpions, as the Skorpion)
	0,//"tknife" (H9: 38)
	213,//"ppsh41" (H9: 39, 7.62 x 25mm: three 71-round drums)
	90//"laserrifle" (H9: 40, a copy of the M4A1's row)
}

new g_AmmoTypes[TS_MAX_WEAPONS] =
{
	0,//"kungfu" (H9: 0 in H9's TSX)
	1,//"glock18",
	// H9: 2 is the Beretta 92F (TSW_BERETTA), on 9mm Parabellum as the akimbo pair
	1,//"beretta",
	1,//"uzi",
	2,//"m3",
	3,//"m4a1",
	1,//"mp5sd",
	1,//"mp5k",
	1,//"aberettas",
	4,//"mk23",
	4,//"amk23",
	2,//"usas",
	5,//"deagle",
	6,//"ak47",
	7,//"57",
	3,//"aug",
	1,//"auzi",
	12,//"skorpion",
	8,//"m82a1",
	7,//"mp7",
	2,//"spas",
	4,//"gcolts",
	9,//"glock20",
	4,//"ump",
	0,//"m61grenade",
	0,//"cknife",
	2,//"mossberg",
	3,//"m16a4",
	10,//"mk1",
	0,//"c4",
	7,//"a57",
	11,//"rbull",
	3,//"m60e3",
	2,//"sawed_off",
	0,//"katana",6
	0,//"sknife",
	13,//"contender" (H9: 36)
	12,//"askorpion" (H9: 37, .32 ACP as the Skorpion)
	0,//"tknife" (H9: 38)
	0,//"ppsh41" (H9: 39, 7.62 x 25mm: no ARP ammo item is this one)
	0//"laserrifle" (H9: 40, plasma cells: no ARP ammo item either)
}

new Handle:g_SqlHandle

new g_WeaponTable[] = "arp_weapons"

public plugin_precache()
{
	arpvgui_precache()
}

public plugin_init()
{
	ARP_RegisterPlugin("TS Compatibility",ARP_VERSION,"The ApolloRP Team","Provides TS support for ARP")
	
	if(!module_exists("tsx") && !module_exists("tsfun"))
	{
		ARP_Log("The TS compatibility plugin has been enabled in a non-TS mod.")
		pause("d")
		
		return
	}
	
	ARP_RegisterCmd("arp_addgun","CmdAddGun","(ADMIN) <weaponid> <ammo> <extra> <save (0/1)> - adds gun to wall")
	
	arpvgui_init("arpts")
	register_menucmd(register_menuid(g_AttachMenu),g_Keys,"AttachMenuHandle")
	
	TeamInit()
}

public plugin_cfg()
	TeamConfigured()

public ARP_Error(const Reason[])
	pause("d")

public plugin_natives()
{
	set_module_filter("ModuleFilter")
	set_native_filter("NativeFilter")
}

public ModuleFilter(const Module[])
{
    if(equali(Module,"tsx") || equali(Module,"tsfun") || equali(Module,"xstats"))
        return PLUGIN_HANDLED
	
    return PLUGIN_CONTINUE
}

public NativeFilter(const Name[],Index,Trap)
{
    if(!Trap)
        return PLUGIN_HANDLED
        
    return PLUGIN_CONTINUE
}

public ARP_RegisterItems()
{
	new TSWeaponNames[TS_MAX_WEAPONS][2][] =
	{
		{"",""},
		{"GLOCK-18","Handgun; Non-Restricted; 9mm Parabellum"},
		{"",""},
		{"Mini-Uzi","Sub-machine Gun; Non-Restricted; 9mm Parabellum"},
		{"Benelli M3","Shotgun; Restricted; 12 gauge 2 3/4^""},
		{"Colt M4A1","Rifle; Restricted; 5.56mm (NATO)"},
		{"H&K MP5SDA5","Sub-machine Gun; Restricted; 9mm Parabellum"},
		{"H&K MP5K","Sub-machine Gun; Non-Restricted; 9mm Parabellum"},
		{"Akimbo Beretta 92Fs","Handgun(s); Non-Restricted; 9mm Parabellum"},
		{"H&K SOCOM MK23","Handgun; Non-Restricted; .45 ACP"},
		{"",""},
		{"Daewoo USAS-12","Shotgun; Restricted; 12 gauge 2 3/4^""},
		{"IMI Desert Eagle","Handgun; Non-Restricted; .50 AE"},
		{"Kalashnikova AK-47","Rifle; Prohibited; 7.62mm"},
		{"FN Five-seveN Tactical","Handgun; Non-Restricted; 5.7mm"},
		{"Steyr AUG","Rifle; Restricted; 5.56mm (NATO)"},
		{"",""},
		{"vz. 61 ^"Skorpion^"","Sub-machine Gun; Non-Restricted; .32 ACP"},
		{"Barrett M82A1","Rifle; Prohibited; .50 BMG"},
		{"H&K MP7","Sub-machine Gun; Non-Restricted; 4.6mm"},
		{"SPAS-12","Shotgun; Restricted; 12 gauge 2 3/4^""},
		{"Golden Colt 1911A1s","Handgun; Non-Restricted; .45 ACP"},
		{"GLOCK-20C","Handgun; Non-Restricted; 10mm Auto"},
		{"H&K UMP","Sub-machine Gun; Non-Restricted; .45 ACP"},
		{"M61 Grenade","Special; Prohibited"},
		{"Combat Knife","Special; Non-Restriced"},
		{"Mossberg 500","Shotgun; Non-Restriced; 12 gauge 2 3/4^""},
		{"Colt M16A4","Rifle; Restricted; 5.56mm (NATO)"},
		{"Ruger MK1","Handgun; Non-Restricted; .22 LR"},
		{"",""},
		{"",""},
		{"Taurus Raging Bull","Handgun; Restricted; .454 Casull"},
		{"U.S. Ordnance M60E3","Machine-gun; Prohibited; 7.62mm (NATO)"},
		{"Sawed-Off Shotgun","Shotgun; Prohibited; 12 gauge 2 3/4^""},
		{"Katana","Special; Non-Restricted"},
		{"Seal Knife","Special; Non-Restricted"},
		{"G2 Contender","Handgun; Prohibited; 7.62mm NATO"},
		{"",""},
		{"",""},
		{"PPSh-41","Sub-machine Gun; Prohibited; 7.62 x 25mm"},
		{"Laser Rifle","Rifle; Prohibited; Plasma cell"}
	}
	
	for(new Count;Count < TS_MAX_WEAPONS;Count++)
		if(TSWeaponNames[Count][0][0])
			g_GunStats[Count][ITEMID] = ARP_RegisterItem(TSWeaponNames[Count][0],"_WeaponHandle",TSWeaponNames[Count][1],1)
	
	g_9Parabellum = ARP_RegisterItem("9mm Parabellum Ammo","_Ammo","9mm Parabellum ammo for weapons",1)
	g_12Gauge = ARP_RegisterItem("12 Gauge Shells Ammo","_Ammo","12 Gauge shells for weapons",1)
	g_556NATO = ARP_RegisterItem("5.56mm NATO Ammo","_Ammo","5.56mm NATO ammo for weapons",1)
	g_45ACP = ARP_RegisterItem(".45 ACP Ammo","_Ammo",".45 ACP ammo for weapons",1)
	g_50AE = ARP_RegisterItem(".50 AE Ammo","_Ammo",".50 AE ammo for weapons",1)
	g_762Soviet = ARP_RegisterItem("7.62mm Soviet Ammo","_Ammo","7.62mm Soviet ammo for weapons",1)
	g_57FN = ARP_RegisterItem("5.7mm FN Ammo","_Ammo","5.7mm FN ammo for weapons",1)
	g_50BMG = ARP_RegisterItem(".50 BMG Ammo","_Ammo",".50 BMG ammo for weapons",1)
	g_10Auto = ARP_RegisterItem("10mm Auto Ammo","_Ammo","10mm Auto ammo for weapons",1)
	g_22Hornet = ARP_RegisterItem(".22 Hornet Ammo","_Ammo",".22 Hornet ammo for weapons",1)
	g_454Casull = ARP_RegisterItem(".454 Casull Ammo","_Ammo",".454 Casull ammo for weapons",1)
	g_32ACP = ARP_RegisterItem(".32 ACP Ammo","_Ammo",".32 ACP ammo for weapons",1)
	g_762NATO = ARP_RegisterItem("7.62mm NATO Ammo","_Ammo","7.62mm NATO ammo for weapons",1)
	
#if 0
	new SCWeaponNames[SC_MAX_WEAPONS][2][] =
	{
		{"",""},
		{"Crowbar","Melee; Non-Restricted"},
		{"9mm Handgun","Handgun; Non-Restricted; 9mm"},
		{".357 Handgun","Handgun; Non-Restricted; .357"},
		{"9mm Assault Rifle","Sub-machine Gun; Non-Restricted; 9mm/AR Grenades"},
		{"",""},
		{"Crossbow","Special; Restricted; Bolts"},
		{"Shotgun","Shotgun; Non-Restricted; Shells"},
		{"Rocket-Propelled Grenade Launcher","Explosive; Prohibited; Rockets"},
		{"Gauss Gun","Energy; Prohibited; Cells"},
		{"EGON Gun","Energy; Prohibited; Cells"},
		{"Hornet Gun","Alien; Restricted"},
		{"Hand Grenade","Explosive; Restricted"},
		{"Trip Mine","Explosive; Restricted"},
		{"Satchel","Explosive; Restricted"},
		{"Snark","Alien; Restricted"},
		{"Akimbo Uzis","Sub-machine Gun; Non-Restricted; 9mm"},
		{"Uzi","Sub-machine Gun; Non-Restricted; 9mm"},
		{"Medkit","Special; Non-Restricted"},
		{"",""},
		{"Pipe Wrench","Melee; Non-Restricted"},
		{"Minigun","Machine-gun; Prohibited; Chaingun Ammo"},
		{"Grapple Gun","Alien; Non-Restricted"},
		{"Sniper Rifle","Rifle; Restricted; 7.62"},
		{"",""},
		{"",""},
		{"",""},
		{"",""},
		{"",""},
		{"",""},
		{"",""}
	}
	
	for(new Count;Count < SC_MAX_WEAPONS;Count++)
		if(SCWeaponNames[Count][0][0])
			g_GunStats[Count][ITEMID] = ARP_RegisterItem(SCWeaponNames[Count][0],"_WeaponHandle",SCWeaponNames[Count][1],1)

	g_357
	g_Buckshot
	g_762
	g_Bolts
	g_Cells
	g_RPG
	g_ARGrenades
	g_9mm
	g_Minigun
#endif
}

public CmdAddGun(id,level,cid)
{
	if(!ARP_CmdAccess(id,cid,5))
		return PLUGIN_HANDLED
	
	new WeaponId[33],Ammo[33],Flags[33],Save[33],Float:Origin[3]
	entity_get_vector(id,EV_VEC_origin,Origin)
	
	read_argv(1,WeaponId,32)
	read_argv(2,Ammo,32)
	read_argv(3,Flags,32)
	read_argv(4,Save,32)
	
	ts_weaponspawn(WeaponId,"15",Ammo,Flags,Origin)
	
	if(!str_to_num(Save))
		return PLUGIN_HANDLED
		
	new WeapId = str_to_num(WeaponId),Clip = str_to_num(Ammo),Spawnflags = str_to_num(Flags)
	
	new Query[256]
	format(Query,255,"INSERT INTO %s VALUES ('%d','%d','%d','%d','%d','%d')",g_WeaponTable,WeapId,Clip,Spawnflags,floatround(Origin[0]),floatround(Origin[1]),floatround(Origin[2]))
	
	SQL_ThreadQuery(g_SqlHandle,"IgnoreHandle",Query)
	
	new Name[33],Authid[36]
	get_user_name(id,Name,32)
	get_user_authid(id,Authid,35)
	
	ARP_Log("Cmd: ^"%s<%d><%s><>^" add gun spawn (origin ^"%f %f %f^") (weaponid ^"%s^") (ammo ^"%s^") (flags ^"%s^") (save ^"%d^")",Name,get_user_userid(id),Authid,Origin[0],Origin[1],Origin[2],WeaponId,Ammo,Flags,Save)
	
	show_activity(id,Name,"Add weapon spawn")
	
	return PLUGIN_HANDLED
}

public ARP_Init()
{	
	g_SqlHandle = ARP_SqlHandle()
	
	// Don't do gunspawns if in SQLite.
	if(ARP_SqlMode() == SQLITE)
		return
	
	new Query[256]
	
	format(Query,255,"CREATE TABLE IF NOT EXISTS %s (weaponid INT(11),clips INT(11),flags INT(11),x INT(11),y INT(11),z INT(11))",g_WeaponTable)
	SQL_ThreadQuery(g_SqlHandle,"IgnoreHandle",Query)
	
	format(Query,255,"SELECT * FROM %s",g_WeaponTable)
	SQL_ThreadQuery(g_SqlHandle,"FetchSpawns",Query)
}

public FetchSpawns(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	if(FailState == TQUERY_CONNECT_FAILED)
		return set_fail_state("Could not connect to SQL database.")
	else if(FailState == TQUERY_QUERY_FAILED)
		return set_fail_state("Internal error: consult developer.")
	
	if(Errcode)
		return log_amx("Error on query: %s",Error)
	
	new WeaponId[33],Clips[33],Flags[33],Float:Origin[3]
	while(SQL_MoreResults(Query))
	{
		SQL_ReadResult(Query,0,WeaponId,32)
		SQL_ReadResult(Query,1,Clips,32)
		SQL_ReadResult(Query,2,Flags,32)
		Origin[0] = float(SQL_ReadResult(Query,3))
		Origin[1] = float(SQL_ReadResult(Query,4))
		Origin[2] = float(SQL_ReadResult(Query,5))
		
		ts_weaponspawn(WeaponId,"15",Clips,Flags,Origin)
		
		SQL_NextRow(Query)
	}
	
	return PLUGIN_CONTINUE
}

public IgnoreHandle(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
		return log_amx("Could not connect to SQL database.")//set_fail_state("Could not connect to SQL database.")
	else if(FailState == TQUERY_QUERY_FAILED)
		return log_amx("Internal error: consult developer. Error: %s",Error)
	
	if(Errcode)
		return log_amx("Error on query: %s",Error)
	
	return PLUGIN_CONTINUE
}

public _WeaponHandle(id,ItemId)
{	
	g_Attachments[id] = 0
	g_Gun[id] = ItemId
	
	_Weapon(id,ItemId)
}

public _Weapon(id,ItemId)
{		
	new Menu[512],Pos,Cell = -1,Num,ItemName[33]
	ARP_GetItemName(ItemId,ItemName,32)
	Pos += format(Menu,511,"ARP %s Attachments^n^n",ItemName)
	
	for(new Count;Count < TS_MAX_WEAPONS;Count++)
		if(g_GunStats[Count][ITEMID] == ItemId && g_GunStats[Count][ITEMID])
		{			
			Cell = Count
			g_Cell[id] = Count
			break
		}
	
	if(Cell == -1)
		return
	
	if(!g_GunStats[Cell][ATTACHMENTS])
	{
		GiveWeapon(id)
		return
	}
	
	if(g_GunStats[Cell][ATTACHMENTS] & TSA_FLASHLIGHT)
		Pos += format(Menu[Pos],511 - Pos,"%d. Flashlight %s^n",++Num,g_Attachments[id] & TSA_FLASHLIGHT ? "*" : "")
	if(g_GunStats[Cell][ATTACHMENTS] & TSA_LASERSIGHT)
		Pos += format(Menu[Pos],511 - Pos,"%d. Lasersight %s^n",++Num,g_Attachments[id] & TSA_LASERSIGHT ? "*" : "")
	if(g_GunStats[Cell][ATTACHMENTS] & TSA_SCOPE)
		Pos += format(Menu[Pos],511 - Pos,"%d. Scope %s^n",++Num,g_Attachments[id] & TSA_SCOPE ? "*" : "")
	if(g_GunStats[Cell][ATTACHMENTS] & TSA_SILENCER)
		Pos += format(Menu[Pos],511 - Pos,"%d. Suppressor %s^n",++Num,g_Attachments[id] & TSA_SILENCER ? "*" : "")
		
	format(Menu[Pos],511-Pos,"^n0. Done")
	
	new Keys = (1<<9)
	for(new Count;Count < Num;Count++)	
		Keys |= (1<<Count)
	
	arpvgui_show_menu(id,Keys,Menu,-1,g_AttachMenu,"arpts.attach")
}

public AttachMenuHandle(id,Key)
{
	new Attachments[4],Num,Temp
	Temp = g_GunStats[g_Cell[id]][ATTACHMENTS]
	for(new Count;Count < 4;Count++)
		if(Temp & TSA_FLASHLIGHT)
		{
			Attachments[Num++] = TSA_FLASHLIGHT
			// &= ~x seems to be broken
			Temp -= TSA_FLASHLIGHT
		}
		else if(Temp & TSA_LASERSIGHT)
		{
			Attachments[Num++] = TSA_LASERSIGHT
			Temp -= TSA_LASERSIGHT
		}
		else if(Temp & TSA_SCOPE)
		{
			Attachments[Num++] = TSA_SCOPE
			Temp -= TSA_SCOPE
		}
		else if(Temp & TSA_SILENCER)
		{
			Attachments[Num++] = TSA_SILENCER
			Temp -= TSA_SILENCER
		}
	
	if(Key != 9 && !Attachments[Key])
	{
		_Weapon(id,g_Gun[id])
		return
	}
	
	if(Key == 9)
	{
		GiveWeapon(id)
		return
	}
	
	if(!(g_Attachments[id] & Attachments[Key]))
		g_Attachments[id] += Attachments[Key]
	else
		g_Attachments[id] -= Attachments[Key]
		
	_Weapon(id,g_Gun[id])
}	

GiveWeapon(id)
{
	// H9: the PPSh-41 and the laser rifle are weapons of H9's reTS, there only while the server's h9_customweapons is 1. Without them the gun cannot be
	// made. The core takes the item as this handler returns (neither has an attachment menu, so GiveWeapon runs inside it), so it is put back here, as
	// _Ammo does for a round that fits no weapon, and the player is told.
	if(g_Cell[id] >= 39 && !(cvar_exists("h9_customweapons") && get_cvar_num("h9_customweapons")))
	{
		new Item = g_GunStats[g_Cell[id]][ITEMID]
		ARP_SetUserItemNum(id,Item,ARP_GetUserItemNum(id,Item) + 1)
		ARP_ClientPrint(id,"This server does not have that weapon (h9_customweapons is 0).")
		return
	}
	
	ts_giveweapon(id,g_Cell[id],250,g_Attachments[id])
}

public _Ammo(id,ItemId)
{
	new Mode
	
	if(ItemId == g_9Parabellum)
		Mode = 1
	else if(ItemId == g_12Gauge)
		Mode = 2
	else if(ItemId == g_556NATO)
		Mode = 3 
	else if(ItemId == g_45ACP)
		Mode = 4
	else if(ItemId == g_50AE)
		Mode = 5
	else if(ItemId == g_762Soviet)
		Mode = 6
	else if(ItemId == g_57FN)
		Mode = 7
	else if(ItemId == g_50BMG)
		Mode = 8
	else if(ItemId == g_10Auto)
		Mode = 9
	else if(ItemId == g_22Hornet)
		Mode = 10
	else if(ItemId == g_454Casull)
		Mode = 11
	else if(ItemId == g_32ACP)
		Mode = 12
	else if(ItemId == g_762NATO)
		Mode = 13
	else
		return PLUGIN_HANDLED
		
	new Dummy,Wpn = ts_getuserwpn(id,Dummy,Dummy,Dummy,Dummy)
	if(Mode == g_AmmoTypes[Wpn] && ts_setuserammo(id,Wpn,g_WeaponAmmo[Wpn]))
		return ARP_ClientPrint(id,"You loaded up on ammo.")

	ARP_SetUserItemNum(id,ItemId,ARP_GetUserItemNum(id,ItemId) + 1)
	return ARP_ClientPrint(id,"You are not wielding any weapon with this ammo type.")
}	

// TS ammo: TSX's native ts_setuserammo (tsfun.inc), which H9's AMX Mod X provides for TS 3.0 and
// reTS alike, in place of the TS 3.0 private-data writer that stood here.

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// H9: team play (arp_teamplay, docs\APOLLO_RP.txt, 10).
//
// With arp_teamplay 1 a roleplay map plays on TS's team rules with three teams (ARP_Core sets that up before TS makes its rules: include\ApolloRP_H9Teams.inc), and this
// plugin puts every player on the team of his job and keeps him there. ARP_Core says which team that is (ARP_H9_TeamOf); this plugin moves him to it the way the match
// mode moves a player -- TS's own jointeam, run for him, and the team field of his entity, which RCBot reads -- and tells ARP_H9_TeamChanged. A player cannot move himself:
// jointeam and changeteam (the command that opens TS's team panel) are refused for as long as the teams run.
//
// A move to another team costs the player a respawn, TS's own rule for a team change: it takes him out of play for respawntime (5 seconds in server.cfg) and he presses
// fire to come back, with the hands TS gives at a spawn. A join costs nothing, since a joining player is out of play already: TS gives him the team with the fewest players
// and this plugin moves him to the team of his job as soon as his character is loaded.
//
// mp_defaultteam stays 0, TS's own value. With any other value TS puts every player back on the first team at every spawn (CBasePlayer::Spawn asks SetDefaultPlayerTeam, which
// then answers team_names[0]), so no team but the first would hold; with 0 it keeps the team that the last jointeam wrote into his userinfo.
//
// It does nothing until TS has reported ARP's team list (the TeamNames message): a map that is not on team rules, or whose team list is not ARP's, is left alone and the log
// says so once.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

#define TEAM_TASK 5311
#define TEAM_ENSURE_SECS 60.0	// the server's own files run after the plugins at a map's start and set some of what TeamEnsure sets: it is set again for this long
#define TEAM_JUDGE_SECS 20.0	// how long after the first player is in the game TS may take to report a team of ARP's before it is said to run none
#define TEAM_RETRY_SECS 2.0	// before a move that did not take is asked again
#define TEAM_TRIES 3		// the moves asked for one player before the log says TS refuses them

new p_Teamplay			// arp_teamplay (ARP_Core)
new p_TeamplayOn		// arp_teamplay_on: set here, read by ARP_Core and tsrp_roambots
new g_TeamFwd			// ARP_H9_TeamChanged
new g_TeamTs[MAX_PLAYERS + 1]	// the team TS reports for each player (TeamInfo): ARP_H9_TEAM_*, 0 until it has
new g_TeamPut[MAX_PLAYERS + 1]	// the team ARP last put him on, what ARP_H9_TeamChanged was last told: 0 until it has
new Float:g_TeamTryAt[MAX_PLAYERS + 1]	// when a move for him may be asked again
new g_TeamTries[MAX_PLAYERS + 1]	// the moves asked for him that did not take
new Float:g_TeamToldAt[MAX_PLAYERS + 1]	// when he was last told that his team follows his job
new g_TeamVerdict		// 0 not known yet, 1 TS runs ARP's team list, -1 it does not on this map
new g_TeamSeen			// the TeamInfo messages that named a team of ARP's
new g_TeamListOk		// the TeamNames messages that gave ARP's list
new g_TeamListTs[128]		// the first list of teams TeamNames gave that is not ARP's, as TS sent it
new g_TeamMsgNames		// the id of the TeamNames message once it is hooked
new g_TeamMsgSay		// the id of the SayText message once it is hooked
new g_TeamSayOut		// the join lines of TS that MsgSayText left out
new Float:g_TeamStart		// the clock at plugin_cfg
new Float:g_TeamFirst		// when the first player was found in the game
new g_TeamCorrected		// the settings TeamEnsure has had to put back, one bit each, logged once
new bool:g_TeamWrote		// a team field of an entity was written, so the switch's going off has something to take back
new const g_TeamSettings[4][] = {"mp_friendlyfire","mp_defaultteam","mp_teammodels_force","mp_teamlist"}

TeamInit()
{
	p_Teamplay = get_cvar_pointer("arp_teamplay")
	p_TeamplayOn = get_cvar_pointer("arp_teamplay_on")
	if(!p_Teamplay || !p_TeamplayOn)
		return

	g_TeamFwd = CreateMultiForward("ARP_H9_TeamChanged",ET_IGNORE,FP_CELL,FP_CELL,FP_CELL)

	// TS tells every client the team of every player with this message, whenever one changes (InitHUD, ChangePlayerTeam): the one reading of a player's team that is
	// right on every platform
	new Msg = get_user_msgid("TeamInfo")
	if(Msg)
		register_message(Msg,"MsgTeamInfo")

	TeamHook()

	register_clcmd("jointeam","CmdJoinTeam")
	register_clcmd("changeteam","CmdChangeTeam")

	ARP_AddCommand("arp_teams","(ADMIN) Shows team play: whether TS reports ARP's three teams, and every player's team by his job, by TS and by his entity")
	register_concmd("arp_teams","CmdTeams",_,"- team play: whether TS reports ARP's three teams, and every player's team")

	set_task(1.0,"TeamTick",TEAM_TASK,"",0,"b")
}

// The two messages that are hooked when the game has registered them: TeamNames, TS's list of teams (sent to a joining player and to everybody after every team change),
// which says what list TS runs, and SayText, for the line TS says to a joining player (MsgSayText)
TeamHook()
{
	if(!g_TeamMsgNames)
	{
		g_TeamMsgNames = get_user_msgid("TeamNames")
		if(g_TeamMsgNames)
			register_message(g_TeamMsgNames,"MsgTeamNames")
	}

	if(!g_TeamMsgSay)
	{
		g_TeamMsgSay = get_user_msgid("SayText")
		if(g_TeamMsgSay)
			register_message(g_TeamMsgSay,"MsgSayText")
	}
}

// arp_teamplay asked for in the server's files (arp.cfg and the map's mapconfig, which the server runs only after this): the settings TS reads as it goes are written now,
// before the first player joins and the first citizen is added
TeamConfigured()
{
	g_TeamStart = get_gametime()

	if(p_Teamplay && h9_teams_requested())
		TeamEnsure()
}

bool:TeamAsked()
	return p_Teamplay && get_pcvar_num(p_Teamplay) != 0

bool:TeamLive()
	return TeamAsked() && p_TeamplayOn && get_pcvar_num(p_TeamplayOn) != 0

// The number of a team of ARP's from the name TS gives it, 0 for any other name
TeamByName(const Name[])
{
	new Own[40]
	for(new Team = ARP_H9_TEAM_FIRST;Team <= ARP_H9_TEAMS;Team++)
	{
		ARP_H9_TeamName(Team,Own,39)
		if(equali(Name,Own))
			return Team
	}

	return ARP_H9_TEAM_NONE
}

// ARP's team list as TS reads mp_teamlist: the names in the order of the numbers, ";" between them
TeamOwnList(List[],Len)
{
	new Own[40]

	List[0] = 0
	for(new Team = ARP_H9_TEAM_FIRST;Team <= ARP_H9_TEAMS;Team++)
	{
		ARP_H9_TeamName(Team,Own,39)
		if(Team > ARP_H9_TEAM_FIRST)
			add(List,Len,";")
		add(List,Len,Own)
	}
}

// What TS reads as it goes, and the list others read: mp_friendlyfire at every hit (1: a hit between two players of one team hurts, as the owner asked), mp_defaultteam at every
// spawn (0, TS's own: a player keeps the team of his last jointeam; any other value puts everybody back on the first team at each spawn) and mp_teammodels_force at every team
// and userinfo change (0: the server never writes a model key). mp_teamlist is what TS read when it made its rules; it is written again only so that what the console and the
// other plugins read is the same. game.cfg, server.cfg and the mapconfig set some of these after the plugins start.
TeamEnsure()
{
	new Have[128],List[128]

	TeamSetting(0,1)
	TeamSetting(1,0)
	TeamSetting(2,0)

	TeamOwnList(List,127)

	get_cvar_string("mp_teamlist",Have,127)
	if(!equal(Have,List))
	{
		set_cvar_string("mp_teamlist",List)
		TeamCorrected(3,Have)
	}
}

TeamSetting(Index,Value)
{
	if(!cvar_exists(g_TeamSettings[Index]) || get_cvar_num(g_TeamSettings[Index]) == Value)
		return

	new Was[16]
	get_cvar_string(g_TeamSettings[Index],Was,15)
	set_cvar_num(g_TeamSettings[Index],Value)
	TeamCorrected(Index,Was)
}

// A setting that was not what team play needs when it was looked at: said once, with what it was (the first time it is a config file of the server, run after the plugins)
TeamCorrected(Index,const Was[])
{
	if(g_TeamCorrected & (1<<Index))
		return

	g_TeamCorrected |= (1<<Index)
	log_amx("[ARP] team play set %s, which was ^"%s^".",g_TeamSettings[Index],Was)
}

// What TS says of a player's team
public MsgTeamInfo(MsgId,Dest,Ent)
{
	new Who = get_msg_arg_int(1)
	if(Who < 1 || Who > MAX_PLAYERS)
		return PLUGIN_CONTINUE

	new Name[40]
	get_msg_arg_string(2,Name,39)

	g_TeamTs[Who] = TeamByName(Name)
	if(g_TeamTs[Who])
		g_TeamSeen++

	return PLUGIN_CONTINUE
}

// TS's list of teams: sent to a joining player, and to everybody after every team change. It is the one reading of what list TS runs, as it holds it (mp_teamlist is only what
// was written when it made its rules). A team's name alone cannot say it: the Middle Sea Republic is the first team of the match mode's list too.
public MsgTeamNames(MsgId,Dest,Ent)
{
	new Count = get_msg_arg_int(1),Name[40],Own[40],List[128],bool:Ours = Count == ARP_H9_TEAMS

	if(Count > 8)
		Count = 8

	for(new Index;Index < Count;Index++)
	{
		get_msg_arg_string(2 + Index,Name,39)
		if(Index)
			add(List,127,";")
		add(List,127,Name)

		if(Ours)
		{
			ARP_H9_TeamName(ARP_H9_TEAM_FIRST + Index,Own,39)
			if(!equal(Name,Own))
				Ours = false
		}
	}

	if(Ours)
		g_TeamListOk++
	else if(!g_TeamListTs[0])
		copy(g_TeamListTs,127,List)

	return PLUGIN_CONTINUE
}

// What TS tells a joining player, "* assigned to team X" or "* you are on team 'X'", names the team it gave him by the count of players, before his job has moved him. With
// team play that is not his team, so the line is left out, and TeamNotice says which team his job puts him on.
public MsgSayText(MsgId,Dest,Ent)
{
	if(!TeamAsked())
		return PLUGIN_CONTINUE

	new Text[48]
	get_msg_arg_string(2,Text,47)

	if(equal(Text,"* assigned to team ",19) || equal(Text,"* you are on team ",18))
	{
		g_TeamSayOut++
		return PLUGIN_HANDLED
	}

	return PLUGIN_CONTINUE
}

public client_disconnected(id)
{
	g_TeamTs[id] = 0
	g_TeamPut[id] = 0
	g_TeamTryAt[id] = 0.0
	g_TeamTries[id] = 0
	g_TeamToldAt[id] = 0.0
}

// A player joins: the slot may have been a citizen's, whose team field tsrp_roambots wrote, so he carries no team on his entity until he is placed
public client_putinserver(id)
{
	if(TeamAsked() && !is_user_bot(id))
		entity_set_int(id,EV_INT_team,ARP_H9_TEAM_NONE)
}

// A player may not move himself: his team is the team of his job. Only while the teams run; until then TS's own handling goes on.
public CmdJoinTeam(id)
	return TeamRefuse(id)

public CmdChangeTeam(id)
	return TeamRefuse(id)

TeamRefuse(id)
{
	if(!TeamLive())
		return PLUGIN_CONTINUE

	if(get_gametime() - g_TeamToldAt[id] > 3.0)
	{
		g_TeamToldAt[id] = get_gametime()
		ARP_ClientPrint(id,"Your team follows your job: you cannot pick one.")
	}

	return PLUGIN_HANDLED
}

public TeamTick()
{
	if(!TeamAsked())
	{
		// the switch is off: ARP touches no team, and takes back what it wrote to the entities
		if(g_TeamWrote)
		{
			for(new id = 1;id <= MAX_PLAYERS;id++)
				if(g_TeamPut[id])
				{
					if(is_user_connected(id))
						entity_set_int(id,EV_INT_team,ARP_H9_TEAM_NONE)
					g_TeamPut[id] = 0
				}

			g_TeamWrote = false
		}

		return
	}

	if(!g_TeamMsgNames || !g_TeamMsgSay)
		TeamHook()

	if(g_TeamVerdict != -1 && get_gametime() - g_TeamStart < TEAM_ENSURE_SECS)
		TeamEnsure()

	if(g_TeamVerdict == 0)
		TeamJudge()

	if(g_TeamVerdict != 1)
		return

	new Players[MAX_PLAYERS],Playersnum
	get_players(Players,Playersnum,"ch")

	for(new Count;Count < Playersnum;Count++)
		TeamPlace(Players[Count])
}

// Whether TS runs ARP's teams, from what it has told: a TeamNames message with ARP's list says it does; one with another list (the match mode's) says it runs a list that is
// not ARP's, and none at all, a while after the first player is in the game, says it runs no team rules
TeamJudge()
{
	new Map[64],List[128]
	get_mapname(Map,63)
	TeamOwnList(List,127)

	if(g_TeamListOk > 0)
	{
		g_TeamVerdict = 1
		set_pcvar_num(p_TeamplayOn,1)
		log_amx("[ARP] team play runs on %s: TS reports the teams %s. Every player is put on the team of his job; friendly fire is on and TS writes no model.",Map,List)
		return
	}

	if(g_TeamListTs[0])
	{
		g_TeamVerdict = -1
		log_amx("[ARP] arp_teamplay is 1, but TS reports the teams ^"%s^", not ^"%s^": ts\game.cfg runs h9_arp_teams to write ARP's list, and the log says when it does. Teams are left alone on %s; a change needs a map change.",g_TeamListTs,List,Map)
		return
	}

	if(g_TeamFirst == 0.0)
	{
		if(get_playersnum() > 0)
			g_TeamFirst = get_gametime()

		return
	}

	if(get_gametime() - g_TeamFirst > TEAM_JUDGE_SECS)
	{
		g_TeamVerdict = -1
		log_amx("[ARP] arp_teamplay is 1, but TS has reported no team on %s since a player came in (mp_teamplay is %d): the map does not run TS's team rules. Teams are left alone; a change needs a map change.",Map,get_cvar_num("mp_teamplay"))
	}
}

// One player: on the team of his job, and told so; moved there if TS has him on another. Not before his job is loaded, and not while he is dying (TS keeps his body then); a
// player out of play, joining, spectating or waiting for his respawn, is moved at no cost.
TeamPlace(id)
{
	if(!ARP_PlayerReady(id))
		return

	new Want = ARP_H9_TeamOf(id),Have = g_TeamTs[id],Cost
	if(Want == ARP_H9_TEAM_NONE || Have == ARP_H9_TEAM_NONE)
		return

	if(Have != Want)
	{
		new Alive = is_user_alive(id)
		if((!Alive && !entity_get_int(id,EV_INT_iuser1)) || get_gametime() < g_TeamTryAt[id])
			return

		g_TeamTryAt[id] = get_gametime() + TEAM_RETRY_SECS
		TeamMove(id,Want)

		// the command runs in the game at once, and TS's TeamInfo comes back before it returns
		if(g_TeamTs[id] != Want)
		{
			if(++g_TeamTries[id] == TEAM_TRIES)
				log_amx("[ARP] team play: jointeam %d did not take for player %d (TS says team %d): asked %d times, and asked again every %.0f seconds.",Want,id,g_TeamTs[id],TEAM_TRIES,TEAM_RETRY_SECS)

			return
		}

		Cost = Alive
	}

	g_TeamTries[id] = 0

	if(entity_get_int(id,EV_INT_team) != Want)
	{
		entity_set_int(id,EV_INT_team,Want)
		g_TeamWrote = true
	}

	if(g_TeamPut[id] != Want)
	{
		new Old = g_TeamPut[id]
		g_TeamPut[id] = Want
		TeamTell(id,Old,Want)
		TeamNotice(id,Want,Cost)
	}
}

// jointeam, run for the player in the game as he would run it: TS's TeamInfo comes with it
TeamMove(id,Team)
{
	new Index[4]
	num_to_str(Team,Index,3)
	engclient_cmd(id,"jointeam",Index)
}

// A player is told his team when ARP has put him on it, the first time after he joins and whenever it changes (TS's own line at a join names the team it gave him by the count of
// players, and is left out: MsgSayText): with what TS does to a player who was in play
TeamNotice(id,Team,Cost)
{
	new Name[40]
	ARP_H9_TeamName(Team,Name,39)

	if(Cost)
		ARP_ClientPrint(id,"Your job puts you on the %s team. TS takes you out of play for a few seconds on a team change: press fire to come back.",Name)
	else
		ARP_ClientPrint(id,"Your job puts you on the %s team.",Name)
}

TeamTell(id,Old,New)
{
	new Return
	if(g_TeamFwd > 0)
		ExecuteForward(g_TeamFwd,Return,id,Old,New)
}

public CmdTeams(id,cid)
{
	if(!ARP_CmdAccess(id,cid,1))
		return PLUGIN_HANDLED

	console_print(id,"[ARP] team play: arp_teamplay %d, ARP's team list reported by TS: %s (%d TeamNames of ARP's list, another list %s; %d TeamInfo of ARP's teams; %d join lines of TS left out), arp_teamplay_on %d.",get_pcvar_num(p_Teamplay),g_TeamVerdict == 1 ? "yes" : (g_TeamVerdict == -1 ? "no" : "not known yet"),g_TeamListOk,g_TeamListTs[0] ? g_TeamListTs : "-",g_TeamSeen,g_TeamSayOut,get_pcvar_num(p_TeamplayOn))
	new List[128]
	get_cvar_string("mp_teamlist",List,127)
	console_print(id,"[ARP] TS: mp_teamplay %d, mp_friendlyfire %d, mp_defaultteam %d, mp_teammodels_force %d, mp_teamlist ^"%s^".",get_cvar_num("mp_teamplay"),get_cvar_num("mp_friendlyfire"),get_cvar_num("mp_defaultteam"),get_cvar_num("mp_teammodels_force"),List)

	new Players[MAX_PLAYERS],Playersnum,Player,Name[32]
	get_players(Players,Playersnum)
	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		get_user_name(Player,Name,31)

		console_print(id,"#%d %s%s: by his job %d, by TS %d, by his entity %d, put by ARP %d",Player,Name,is_user_bot(Player) ? " (a bot)" : "",ARP_H9_TeamOf(Player),g_TeamTs[Player],entity_get_int(Player,EV_INT_team),g_TeamPut[Player])
	}

	return PLUGIN_HANDLED
}
