// Whether or not to use ArrayX (doesn't work on Linux)
// #define ARRAYX

// Whether or not to enable debug mode (tracks amount of queries out, more or less useless)
// #define DEBUG

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <engine>
#include <sqlx>

// H9: the SQL driver arp.ini names by default, sqlite, is loaded with the core, so it works
// without a line in configs\modules.ini (sqlx alone would load mysql, its default).
#pragma loadlib sqlite
#include <hamsandwich>
//#include <tsx>
//#include <tfcx>
#include <ApolloRP>
#include <xs>
#include <tsfun>
#include <h9_presence>
#include <ApolloRP_H9Cfg>
#include <ApolloRP_H9Teams>
#define ARPVGUI_PAGED
#include <ApolloRP_VGui>
#if defined ARRAYX
#include <arrayx_array>
#else
#include <arrayx_travtrie>
#endif

// CAPTAIN! WE NEED MORE DILITHIUM CRYSTALS!
#pragma dynamic 32768

#define STD_USER_QUERIES 3

#define USER_ITEM_SCAN new Success,Next = array_first(g_UserItemArray[id],0,Success); if(Success) for(;Success;Next = array_next(g_UserItemArray[id],Next,Success))

// the handle of the connection tuple
new Handle:g_SqlHandle
new SQLMODE:g_SqlMode

// the name of the users table
new g_UserTable[64] = "arp_users"
// the name of the jobs table
new g_JobsTable[64] = "arp_jobs"
// the name of the property table
new g_PropertyTable[64] = "arp_property"
// name of the doors table
new g_DoorsTable[64] = "arp_doors"
// door keys
new g_KeysTable[64] = "arp_keys"
// name of the items table
new g_ItemsTable[64] = "arp_items"
// name of the orgs table
//new g_OrgsTable[] = "arp_orgs"
// name of the data table
new g_DataTable[64] = "arp_data"

// SQL cvars, serve no purpose other than for other plugins
// in case they want to make their own tuple or something
new const g_HostCvar[] = "arp_sql_host"
new const g_UserCvar[] = "arp_sql_user"
new const g_PassCvar[] = "arp_sql_pass"
new const g_DbCvar[] = "arp_sql_db"
new const g_TypeCvar[] = "arp_sql_type"

new g_Host[64] = "localhost"
new g_User[64] = "root"
new g_Pass[64] = ""
new g_Db[64] = "arp"
new g_Type[64] = "sqlite"

new g_Authid[MAX_PLAYERS + 1][36]

// H9: the key of each player's character: the authid his rows are kept under (ARP_GetUserKey)
new g_CharKey[MAX_PLAYERS + 1][36]
// H9: each player's havoc9.org account once h9_presence has proved it (0: none yet), and the seconds his load has
// waited for it (-1: it does not wait)
new g_Acct[MAX_PLAYERS + 1]
new g_AcctWait[MAX_PLAYERS + 1]
new g_Presence
new p_AcctWait
// the table that ties an authid to the account it was seen with
new g_IdsTable[64] = "arp_ids"

new g_PluginEnd

// amount of jobs currently loaded
new g_JobsNum
// array for jobs
new g_JobsArray
// what the id of each job is
/*new g_JobIds[MAX_JOBS]
// where the jobs names are stored
new g_JobNames[MAX_JOBS][33]
// access of the jobs
new g_JobAccess[MAX_JOBS]
// salary of jobs
new g_JobSalaries[MAX_JOBS]*/

//new g_OrgsNum
//new g_OrgsArray

// rather than making "new Query" every time we use it,
// we'll instead just have one global variable to make
// it a lot faster and less resource consuming.
// this will also act as cache to speed other stuff up
new g_Query[4096]
new g_Cache[4096]

new g_BankMoney[MAX_PLAYERS + 1]
new g_Money[MAX_PLAYERS + 1]
new g_Salary[MAX_PLAYERS + 1]
new g_UserItemArray[MAX_PLAYERS + 1]
new g_UserItemNum[MAX_PLAYERS + 1]
new g_ItemUse[MAX_PLAYERS + 1]
new g_JobId[MAX_PLAYERS + 1]
new g_Hunger[MAX_PLAYERS + 1]
new g_Access[MAX_PLAYERS + 1]
new g_AccessCache[MAX_PLAYERS + 1]
new g_JobRight[MAX_PLAYERS + 1]
new g_BadJob[MAX_PLAYERS + 1]
new g_KeptJob[MAX_PLAYERS + 1][33]   // H9: the job a character was saved with when this map has no job of that name; it goes back at the save unless he takes another job here
new g_Falling[MAX_PLAYERS + 1]

#if defined DEBUG
new g_TotalQueries
#endif

new g_Plugin

new p_AuxType
/*new p_AuxX
new p_AuxY
new p_AuxR
new p_AuxG
new p_AuxB*/
new p_StartMoney
new p_ItemsPerPage
new p_SaveTime
new p_Lights
new p_WalletDeath
new p_GodDoors
new p_GodWindows
new p_FallDamage
new p_Performance
new p_Log
new p_GameName
new p_Welcome[3]
new p_HoverMessage
new p_H9ItemHover	// H9: arp_h9_itemhover, 1 gives the look-at line of a dropped item (GetMsg), 0 none
new p_Toast	// H9: arp_h9_toast, 0 chat as stock, 1 [ARP] chat lines as popups over the crosshair, 2 both (H9_Toast)
new p_H9Plaque	// H9: arp_h9_plaque, 1 says what a property door, an NPC and a player is when it is looked at (GetMsg, H9_Plaque*), 0 is stock ARP's text
new p_H9Teamplay	// H9: arp_teamplay, 1 asks for team play on a roleplay map: TS's team rules, three teams, a player's team from his job (H9_TeamsPrecache, ARP_TS)
new p_H9TeamplayOn	// H9: arp_teamplay_on, set by ARP_TS: 1 while TS reports ARP's three teams on this map (H9_TeamsLive)
new bool:g_H9TeamsAsked	// H9: arp_teamplay was 1 in the server's files when this map loaded, so the game's half of it was set up (H9_TeamsPrecache)
// H9: the one table of the teams' names, by team number (include\ApolloRP_H9Teams.inc): the map's mp_teamlist, ARP_H9_TeamName and so TS's scoreboard spell them so, and nothing
// else in the source holds a team's name: renaming a team is its line here. The order is the numbering, and the client colours a team by its number (1 blue, 2 red, 3 yellow).
new const g_H9TeamNames[ARP_H9_TEAMS + 1][] = {"","Middle Sea Republic","Insurrection","Proletarians"}
//new p_CharacterSheet

enum _:HUD_CVARS
{
	X = 0,
	Y,
	R,
	G,
	B
}

new p_Hud[HUD_NUM][HUD_CVARS]
new g_HudObjects[HUD_NUM]
new TravTrie:g_HudArray[MAX_PLAYERS + 1][HUD_NUM]
// H9: whether each of a player's HUDs was last sent empty (RenderHud)
new g_HudCleared[MAX_PLAYERS + 1][HUD_NUM]
new g_HudPending

// H9: the HUD as a panel. A player whose game says so (the userinfo key _h9arphud, which its cl_h9_arphud keeps) is sent each HUD's
// lines in the user message H9ArpHud in place of the hudmessage; every other player keeps the hudmessage. A message holds a few
// lines of one HUD, each with its kind (HUDK_*), and a HUD that needs more is sent as parts, the last one marked; the game keeps
// what it was last given until it is given something else. docs\APOLLO_RP.txt, section 2.
#define HUDP_MAX_LINES 24      // lines of one HUD that are sent
#define HUDP_LINE_LEN 173      // room for a line: 172 characters of it are sent
#define HUDP_MSG_MAX 184       // bytes of one message: the engine's 192 less a margin
#define HUDP_NOTICE_GAP 1.5    // seconds before the notice's unchanged lines are sent again
#define HUDP_OP_CONTENT 1      // the lines of one HUD
#define HUDP_OP_CLEAR 2        // one HUD taken down
#define HUDP_OP_CLEAR_ALL 3    // every HUD taken down

// why a player is, or is not, sent the panel (g_HudWhy)
#define HUDWHY_PANEL 0
#define HUDWHY_SERVER 1
#define HUDWHY_NOMSG 2
#define HUDWHY_NOVGUI 3
#define HUDWHY_NOKEY 4
#define HUDWHY_OFF 5

new const g_HudWhyText[][] =
{
	"_h9arphud is 1",
	"arp_hud_panel is 0 on this server",
	"the H9ArpHud message was not registered",
	"his game draws no H9 panels (no _h9vgui, cl_h9_vgui 0 or h9_vgui 0)",
	"his game sends no _h9arphud (an older game, or its userinfo is full)",
	"_h9arphud is 0 (cl_h9_arphud 0)"
}

new g_HudMsg
new p_HudPanel
new p_HudRefresh
new g_HudPanel[MAX_PLAYERS + 1]
new g_HudWhy[MAX_PLAYERS + 1] = {-1,...}
new g_HudGen[MAX_PLAYERS + 1][HUD_NUM]
new g_HudSig[MAX_PLAYERS + 1][HUD_NUM]
new Float:g_HudSentAt[MAX_PLAYERS + 1][HUD_NUM]
new g_HudSentMsgs[MAX_PLAYERS + 1]
new g_HudFirstLogged[MAX_PLAYERS + 1]
new g_HudLast[MAX_PLAYERS + 1][HUD_NUM][96]
new g_PanelText[HUDP_MAX_LINES][HUDP_LINE_LEN]
new g_PanelKind[HUDP_MAX_LINES]
new g_PanelNum

// H9: the plaque (arp_h9_plaque): what a player looks at, built as the lines of the notice HUD, each with its kind (HUDK_PLAQUE and the others of
// include\ApolloRP_HUD.inc). A player who keeps looking at the same thing is left alone for PLAQUE_REBUILD seconds, then it is built again.
#define PLAQUE_LINES 8
#define PLAQUE_REBUILD 0.25
#define H9_ACCESS_G (1<<6)     // the access letter g, the Lord Minister's own
new const g_H9InsurgentAccessCvar[] = "arp_h9_insurgent_access"   // the access letters of the Insurgency's jobs and properties
new g_PlaqueKind[PLAQUE_LINES]
new g_PlaqueText[PLAQUE_LINES][HUDP_LINE_LEN]
new g_PlaqueNum
new g_PlaqueKey[MAX_PLAYERS + 1]
new Float:g_PlaqueAt[MAX_PLAYERS + 1]

new g_Time

new g_ItemsArray
new g_ItemsNum

new TravTrie:g_EventTrie

new g_Display[MAX_PLAYERS + 1] = {1,...}

new g_GotInfo[MAX_PLAYERS + 1]
new g_Saving[MAX_PLAYERS + 1]
/*
new g_ItemsNames[MAX_ITEMS][33]
new g_ItemsIds[MAX_ITEMS]
new g_ItemsPlugin[MAX_ITEMS]
new g_ItemsHandler[MAX_ITEMS][33]
new g_ItemsDisposable[MAX_ITEMS]
new g_ItemsDescription[MAX_ITEMS][64]
*/

new g_NpcClassname[] = "arp_npc"
new g_NpcZoneClassname[] = "arp_zone"

new g_CommandNum
new g_CommandArray
//new g_CommandNames[MAX_COMMANDS][33]
//new g_CommandDescriptions[MAX_COMMANDS][64]

new g_RegisterItem

new g_MenuPage[MAX_PLAYERS + 1]
new g_CurItem[MAX_PLAYERS + 1]
new g_Keys = MENU_KEY_0|MENU_KEY_1|MENU_KEY_2|MENU_KEY_3|MENU_KEY_4|MENU_KEY_5|MENU_KEY_6|MENU_KEY_7|MENU_KEY_8|MENU_KEY_9
new g_ItemsMenu[] = "ARP_ItemsMenu"
new g_ItemsDrop[] = "ARP_ItemsDrop"
new g_ItemsGive[] = "ARP_ItemsGive"
new g_ItemsOptions[] = "ARP_ItemsOptions"

new g_ItemClassname[] = "arp_item"
new g_ItemModel[] = "models/arp/w_backpack.mdl"
new Float:g_H9ItemScan[MAX_PLAYERS + 1]	// H9: when a player's look at the dropped items was last tried (GetMsg)

// H9: the picture of a dropped item over its pack (arp_h9_itemicon, H9_ItemIconMake). A sprite entity of the class arp_item_icon floats over the pack and shows the item's frame of
// sprites/h9_arpicons.spr, the sheet the inventory window's tiles are drawn from; sprites/h9_arpicons.txt names the frames (read at precache: an item's name in lower case, then its
// frame). The sheet is a sprite of type SPR_FWD_PARALLEL, which faces the viewer whichever way he looks, and of format SPR_ALPHTEST, with the middle of each frame at the entity's
// origin. The icon is drawn solid (kRenderNormal) and unlit: the client lights an alpha-test sprite (r_sprite_lighting) when its renderamt is above 127, and the picture is to read
// in a dark corridor as it does in the window. The renderamt is 0 under a renderfx that is not none (kRenderFxNoDissipation, which does nothing to a sprite that is not a glow): the
// client sets the renderamt of every kRenderNormal entity whose renderfx is none to 255 (CL_LinkPacketEntities). EF_FULLBRIGHT is no way to unlit: it is bit 27, the entity state
// carries the effects in 8 bits, and the client would be sent 255, which has EF_NODRAW in it. The pack keeps its icon's entity in iuser3; the icon keeps its pack in iuser1 and
// the number it was made in in iuser2.
new g_ItemIconSheet[] = "sprites/h9_arpicons.spr"
new g_ItemIconList[] = "sprites/h9_arpicons.txt"
new g_ItemIconClassname[] = "arp_item_icon"
new g_ItemIconIdx	// the sheet's model index: 0 when the sheet or its list is not there (or arp.cfg has arp_h9_itemicon 0), and no icon is made
new Trie:g_ItemIconFrames	// an item's name in lower case -> its frame in the sheet
new g_ItemIconSerial	// the number the last icon was made in
new p_H9ItemIcon
new p_H9ItemIconMax
new p_H9ItemIconScale
#define H9_ITEMICON_MAX 128	// the most icons arp_h9_itemicon_max can allow
#define H9_ITEMICON_SPARE 100	// the edicts left free for the engine and the other plugins: no icon is made when fewer are left

// H9: the glow of a pack that has just been dropped (arp_h9_itemglow, H9_ItemGlowStart, H9_ItemGlowBeat, H9_ItemGlowPulse): a point light in a purple that shows the pack in a dark corner, sent
// as a pulse that fades out by itself in a second and a quarter and sent again every beat while the pack has time left to glow. It is a message and no entity: nothing in the entity table and
// nothing to take down. The game's time a pack glows until is kept in its fuser1; a pack that has none (one a map places) never glows. The beat is a task that runs only while a pack glows.
new p_H9ItemGlow
new p_H9ItemGlowTime
new p_H9ItemGlowRadius
new p_H9ItemGlowColor
#define H9_ITEMGLOW_BEAT 1.5	// the seconds between one pulse of the light and the next
#define H9_ITEMGLOW_MAX 32	// the most packs that are sent a pulse in one beat
#define H9_ITEMGLOW_TASK 94780	// the beat's task

// H9: the forwards ARP_Inventory implements when it is loaded (include\ApolloRP_Items.inc); with none loaded each answers 0 and the core is stock ARP
new g_H9FwdCount
new g_H9FwdRoom
new g_H9FwdUse
new g_H9FwdNote

new TravTrie:g_ClassArray

new g_PropertyArray
new g_PropertyNum

new TravTrie:g_MenuArray[MAX_PLAYERS + 1]
new g_MenuAccepting[MAX_PLAYERS + 1]

//new TravTrie:g_Characters[33]

new g_DoorArray
new g_DoorNum

new g_Joined[MAX_PLAYERS + 1]

new Float:g_MaxSpeed[MAX_PLAYERS + 1]

new g_ConfigsDir[128]

// H9: 1 runs a map's own SQL file at map start when every statement in it can be run again and again (LoadMapSql)
new p_MapSqlAuto

new g_Version[] = ARP_VERSION

new TravTrie:g_PluginTrie

new TravTrie:g_SpeedTrie[MAX_PLAYERS + 1]
new Float:g_SpeedOverride[MAX_PLAYERS + 1]
new g_SpeedOverridePlugin[MAX_PLAYERS + 1]

enum MODS
{
	HL = 0,
	TS,
	TFC,
	CS
}

new MODS:g_Mod

public plugin_init()
{			
	register_cvar("arp_version",g_Version,FCVAR_SERVER)
	
	// H9: whether h9_presence is loaded, which proves a player's havoc9.org account
	g_Presence = LibraryExists("h9_presence",LibType_Library)
	
	arpvgui_init("arpcore")

	g_H9FwdCount = CreateMultiForward("ARP_InvOnCount",ET_STOP2,FP_CELL,FP_CELL,FP_CELL,FP_CELL)
	g_H9FwdRoom = CreateMultiForward("ARP_InvOnRoom",ET_STOP2,FP_CELL,FP_CELL,FP_CELL)
	g_H9FwdUse = CreateMultiForward("ARP_InvOnUse",ET_IGNORE,FP_CELL,FP_CELL,FP_CELL)
	g_H9FwdNote = CreateMultiForward("ARP_InvOnNote",ET_STOP2,FP_CELL,FP_CELL,FP_STRING)
	
	register_menucmd(register_menuid(g_ItemsMenu),g_Keys,"ItemsHandle")
	register_menucmd(register_menuid(g_ItemsOptions),g_Keys,"ItemsOptions")
	register_menucmd(register_menuid(g_ItemsDrop),g_Keys,"ItemsDrop")
	register_menucmd(register_menuid(g_ItemsGive),g_Keys,"ItemsGive")
	
	new ConfigsDir[128]
	get_configsdir(ConfigsDir,127)
	server_cmd("exec %s/arp/arp.cfg",ConfigsDir)
	
	// I don't like doing this, but since TSRP generally
	// has too many ents, I'm going to avoid spawning an
	// ent and making it think every second.
	// This will also calculate time.
	set_task(1.0,"ShowHud")
	set_task(get_pcvar_float(p_SaveTime),"SaveData")
	
	register_event("DeathMsg","EventDeathMsg","a")
	register_event("ResetHUD","EventResetHUD","b")
	
	register_forward(FM_Sys_Error,"plugin_end")
	//register_forward(FM_GetGameDescription,"ForwardGetGameDescription")
	register_forward(FM_SetClientMaxspeed,"ForwardSetClientMaxspeed")
	
	ARP_RegisterCmd("say /buy","CmdBuy","Allows you to buy properties you're looking at")
	ARP_RegisterCmd("say /items","CmdItems","Shows your items and allows you to control them")
	ARP_RegisterCmd("say /inventory","CmdItems","Shows your items and allows you to control them")
	ARP_RegisterCmd("arp_joblist","CmdJobList","Shows jobs list")
	ARP_RegisterCmd("arp_itemlist","CmdItemList","Shows item list")
	ARP_RegisterCmd("arp_help","CmdHelp","Shows command list")
	ARP_RegisterCmd("arp_menu","CmdMenu","Shows client menu")
	ARP_RegisterCmd("say /menu","CmdMenu","Shows client menu")
	ARP_RegisterCmd("arp_plugins","CmdPlugins","Shows current plugins running")
	ARP_RegisterCmd("arp_query","CmdQuery","(ADMIN) Executes an SQL query")

	// H9: who is sent the HUD as a panel and who the text HUD (a console command too, so the server console can ask)
	ARP_AddCommand("arp_hudstate","(ADMIN) Shows who is sent the HUD panel and who the text HUD, and what was last sent")
	register_concmd("arp_hudstate","CmdHudState",_,"- who is sent the HUD panel and who the text HUD")
	
	register_touch("player","func_door","PlayerTouch")
	register_touch("func_door","player","PlayerTouch")
	register_touch("player","func_door_rotating","PlayerTouch")
	register_touch("func_door_rotating","player","PlayerTouch")
	
	for(new Count;Count < HUD_NUM;Count++)
		g_HudObjects[Count] = CreateHudSyncObj()
	
	//register_clcmd("amx_employ","CmdEmploy")
	//register_clcmd("amx_setwallet","CmdSetWallet")
	//register_clcmd("amx_setbank","CmdSetBank")
	//register_clcmd("amx_setjob","CmdSetJob")
	
	//register_touch(g_ItemClassname,"player","TouchItem")
	//register_touch("player",g_ItemClassname,"TouchItem2")
	
	#if defined DEBUG
	register_clcmd("arp_queries","CmdQueries")
	#endif
	
	set_task(1.0,"GodEnts")

	// H9: the icons of the dropped items whose packs are gone are taken down (H9_ItemIconSweep)
	set_task(5.0,"H9_ItemIconSweep",0,"",0,"b")
	
	if(module_exists("tsfun") || module_exists("tsx")) g_Mod = TS
	else if(module_exists("tfcx")) g_Mod = TFC
	else if(module_exists("csx") || module_exists("cstrike")) g_Mod = CS
	// No such module
	else /*if(module_exists("svencoop")*/ g_Mod = HL
	
	if(g_Mod != TS && g_Mod != CS) 
	{
		new Mod[12]
		get_modname(Mod,11)
		
		server_print("Apollo RP is optimized for The Specialists and Counter-Strike. Some functionality will be disabled to allow operation on ^"%s^".",Mod)
	}
	
	//register_concmd("getclasses","CmdGetClasses")
}

#if 0
public CmdGetClasses(id)
{
	new travTrieIter:Iter = GetTravTrieIterator(g_ClassArray),Cell,ClassHeader[64],Loaded,TravTrie:CurTrie,TravTrie:PluginTrie,Flag,ReadTable[64],Garbage[1]
	while(MoreTravTrie(Iter))
	{		
		ReadTravTrieKey(Iter,ClassHeader,63)
		ReadTravTrieCell(Iter,Cell)
		
		client_print(id,print_console,"ClassHeader:%s",ClassHeader)
		server_print("ClassHeader:%s",ClassHeader)
	}
	DestroyTravTrieIterator(Iter)
}
#endif

// H9: a player's character is kept under a key, the authid its rows are under. It is the engine's authid, except for a
// player whose havoc9.org account h9_presence proves and who made his character under an earlier authid (the address of
// the server changed, and the engine's authid with it): arp_ids lists the authids each account was seen with, the first
// of them is its character's key. No row of another table is ever changed to follow an account.
ArpKey(id,Key[],Len)
{
	if(g_CharKey[id][0])
		copy(Key,Len,g_CharKey[id])
	else
		get_user_authid(id,Key,Len)
}

// H9: the havoc9.org account h9_presence has proved for the player: 0 for none, not yet, or no h9_presence
ArpAccount(id)
{
	if(!g_Presence || get_pcvar_num(p_AcctWait) < 1 || !is_user_connected(id))
		return 0
	
	return h9p_account(id)
}

// H9: whether the player's game can prove an account here: h9_presence challenges, and the game is H9XASH linked to one
// (_h9idv 1: it answers the challenge; _h9lnk 1: its player id is an account's)
bool:ArpCandidate(id)
{
	if(!g_Presence || is_user_bot(id) || get_pcvar_num(p_AcctWait) < 1 || (!get_cvar_num("h9_presence_challenge") && !get_cvar_num("h9_require_account")))
		return false
	
	new Value[4]
	get_user_info(id,"_h9idv",Value,charsmax(Value))
	if(Value[0] != '1')
		return false
	
	get_user_info(id,"_h9lnk",Value,charsmax(Value))
	
	return Value[0] == '1'
}

// H9: the player's character, read under his key; its items and keys are read once the row is (ArpLoadExtras)
LoadPlayer(id)
{
	new Data[1],Quoted[72]
	Data[0] = id
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),g_CharKey[id])
	
	format(g_Query,4095,"SELECT * FROM %s WHERE authid='%s'",g_UserTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchClientData",g_Query,Data,1)
}

ArpLoadExtras(id)
{
	new Data[1],Quoted[72]
	Data[0] = id
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),g_CharKey[id])
	
	format(g_Query,4095,"SELECT * FROM %s WHERE authidname LIKE '%s|%%'",g_ItemsTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchClientItems",g_Query,Data,1)
	
	format(g_Query,4095,"SELECT * FROM %s WHERE authidkey LIKE '%s|%%'",g_KeysTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchClientKeys",g_Query,Data,1)
}

// H9: the key the join found: the first authid recorded for the account, when the player's authid is recorded (or the
// account is known), else his authid
public FetchClientKey(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	new id = Data[0]
	if(!is_user_connected(id))
		return PLUGIN_CONTINUE
	
	get_user_authid(id,g_CharKey[id],35)
	
	if(FailState != TQUERY_SUCCESS || Errcode)
	{
		format(g_Query,4095,"Could not read the account table: %s",Error)
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(SQL_NumResults(Query) > 0)
	{
		SQL_ReadResult(Query,0,g_CharKey[id],35)
		g_AcctWait[id] = -1
	}
	
	LoadPlayer(id)
	
	return PLUGIN_CONTINUE
}

// H9: a join that waits for the account of a player no row knows, a second at a time (the task is id + 2 * MAX_PLAYERS);
// with it, his character is the account's first authid, else, when it never comes, one under his authid
public ArpRetry(Task)
{
	new id = Task - MAX_PLAYERS * 2
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || g_AcctWait[id] < 0)
		return
	
	new Acct = ArpAccount(id),Data[1]
	if(!Acct && ++g_AcctWait[id] <= get_pcvar_num(p_AcctWait))
	{
		set_task(1.0,"ArpRetry",Task)
		return
	}
	
	g_AcctWait[id] = -1
	
	if(!Acct)
	{
		LoadPlayer(id)
		return
	}
	
	Data[0] = id
	format(g_Query,4095,"SELECT authid FROM %s WHERE acct=%d ORDER BY id LIMIT 1",g_IdsTable,Acct)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchClientKey",g_Query,Data,1)
}

// H9: ties the player's authid to his account, once: the next time his authid is another, the account finds his character
ArpRecordId(id)
{
	new Authid[36],Quoted[72]
	get_user_authid(id,Authid,35)
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),Authid)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"INSERT IGNORE INTO %s (authid,acct) VALUES ('%s','%d')",g_IdsTable,Quoted,g_Acct[id])
		case SQLITE:
			format(g_Query,4095,"INSERT OR IGNORE INTO %s (authid,acct) VALUES ('%s','%d')",g_IdsTable,Quoted,g_Acct[id])
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
}

public _ARP_GetUserKey(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),Key[36]
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	ArpKey(id,Key,35)
	set_string(2,Key,get_param(3))
	
	return SUCCEEDED
}

public ModuleFilter(const Module[])
{
    if(equali(Module,"tsfun") || equali(Module,"tsx") || equali(Module,"xstats") || equali(Module,"tfcx") || equali(Module,"cstrike") || equali(Module,"csx"))
        return PLUGIN_HANDLED
	
    return PLUGIN_CONTINUE
}

public NativeFilter(const Name[],Index,Trap)
{
    if(!Trap)
        return PLUGIN_HANDLED
        
    return PLUGIN_CONTINUE
}

public GodEnts()
{	
	if(get_pcvar_num(p_GodDoors))
	{
		new Ent
		while((Ent = find_ent_by_class(Ent,"func_door")) != 0)
			entity_set_float(Ent,EV_FL_takedamage,0.0)
		
		Ent = 0
		while((Ent = find_ent_by_class(Ent,"func_door_rotating")) != 0)
			entity_set_float(Ent,EV_FL_takedamage,0.0)
	}
	
	if(get_pcvar_num(p_GodWindows))
	{
		new Ent
		while((Ent = find_ent_by_class(Ent,"func_breakable")) != 0)
			entity_set_float(Ent,EV_FL_takedamage,0.0)
	}
}

public ForwardGetGameDescription()
{
	static GameName[33]
	get_pcvar_string(p_GameName,GameName,32)
	
	if(GameName[0])
	{
		forward_return(FMV_STRING,GameName)
		return FMRES_SUPERCEDE
	}
	
	return FMRES_IGNORED
}

#if defined DEBUG
public CmdQueries(id,cid)
{
	if(ARP_CmdAccess(id,cid,1))
		client_print(id,print_chat,"Total queries out: %d",g_TotalQueries)
	
	return PLUGIN_HANDLED
}
#endif

public CmdQuery(id,cid)
{
	if(!ARP_CmdAccess(id,cid,2))
		return PLUGIN_HANDLED
	
	new Args[512]
	read_args(Args,511)
	
	remove_quotes(Args)
	trim(Args)
	
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",Args)
	
	console_print(id,"Query executed.")
	
	return PLUGIN_HANDLED
}

public CmdPlugins(id)
{
	new travTrieIter:Iter = GetTravTrieIterator(g_PluginTrie),Plugin,Name[33],Version[10],Author[33],Status[24],Description[128],Garbage[1],Count,Num
	console_print(id,"Apollo RP %s Addons Loaded^nNAME       VERSION   AUTHOR          DESCRIPTION",ARP_VERSION)
	
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKeyEx(Iter,Plugin)
		ReadTravTrieString(Iter,Description,127)
		
		arrayset(Name,0,33)
		arrayset(Version,0,10)
		arrayset(Author,0,33)
		
		get_plugin(Plugin,Garbage,0,Name,32,Version,9,Author,32,Status,23)
		
		if(!equali(Status,"running"))
			continue
		
		for(Count = strlen(Name);Count < 16;Count++)
			Name[Count] = ' '
		
		for(Count = strlen(Version);Count < 9;Count++)
			Version[Count] = ' '
		
		for(Count = strlen(Author);Count < 20;Count++)
			Author[Count] = ' '	
		
		replace(Name,32,"ARP - ","")
		
		console_print(id,"%s %s %s %s",Name,Version,Author,Description)
		Num++
	}
	DestroyTravTrieIterator(Iter)
	
	console_print(id,"%d addons loaded",Num)
	
	return PLUGIN_HANDLED
}

public CmdMenu(id)
{
	TravTrieClear(g_MenuArray[id])
	
	g_MenuAccepting[id] = 1
	
	new Data[1]
	Data[0] = id
	if(_CallEvent("Menu_Display",Data,1))
		return PLUGIN_HANDLED
	
	g_MenuAccepting[id] = 0
	
	new Size = TravTrieSize(g_MenuArray[id])
	if(!Size)
	{
		client_print(id,print_chat,"[ARP] There are no items in the menu.")
		return PLUGIN_HANDLED
	}
	
	new travTrieIter:Iter = GetTravTrieIterator(g_MenuArray[id]),Key[64],Menu = menu_create("ARP Client Menu","ClientMenuHandle"),Info[128]
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Key,63)
		ReadTravTrieString(Iter,Info,127)
		
		menu_additem(Menu,Key,Info)
	}
	DestroyTravTrieIterator(Iter)
	
	arpvgui_menu_display(id,Menu,"arpcore.client","ARP Client Menu","ClientMenuHandle",0)
	
	return PLUGIN_HANDLED
}

public ClientMenuHandle(id,Menu,Item)
{
	if(Item == MENU_EXIT)
	{
		menu_destroy(Menu)
		return PLUGIN_HANDLED
	}
	
	new Info[128],Name[2],Access,Callback
	menu_item_getinfo(Menu,Item,Access,Info,127,Name,1,Callback)
	
	new Forward = CreateOneForward(Info[0],Info[1],FP_CELL),Return
	if(!Forward || !ExecuteForward(Forward,Return,id))
	{
		menu_destroy(Menu)
		format(g_Query,sizeof g_Query - 1,"Function does not exist in plugin %d: %s",Info[0],Info[1])
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	DestroyForward(Forward)
	
	menu_destroy(Menu)
	
	return PLUGIN_HANDLED
}

public client_kill(id)
{
	client_print(id,print_console,"You cannot commit suicide in this server.")
	return PLUGIN_HANDLED
}

public SaveData()
{
	new Data[1]
	if(_CallEvent("Core_Save",Data,0))
	{
		new Float:Performance = get_pcvar_float(p_Performance)
	
		// epsilon format for IEEE precision (if it's 0)
		if(Performance > 0.1)
			set_task(get_pcvar_float(p_SaveTime) * Performance / 100.0,"SaveData")
		
		return
	}
	
	new Players[MAX_PLAYERS],Playersnum
	get_players(Players,Playersnum)
	
	for(new Count;Count < Playersnum;Count++)
		if(g_GotInfo[Players[Count]] >= STD_USER_QUERIES)
			SaveUserData(Players[Count],0)
	
	new InternalName[64],ExternalName[64],OwnerName[33],OwnerAuthid[36],Price,Locked,AccessStr[JOB_ACCESSES + 1],Access,Profit,CurArray,MapName[33],Targetname[33],EntID,Changed
	get_mapname(MapName,32)
	
	for(new Count;Count < g_PropertyNum;Count++)
	{		
		CurArray = array_get_int(g_PropertyArray,Count)
		
		Changed = array_get_int(CurArray,9)
		if(!Changed)
			continue
		
		array_get_string(CurArray,0,InternalName,63)
		array_get_string(CurArray,1,ExternalName,63)
		array_get_string(CurArray,2,OwnerName,32)
		array_get_string(CurArray,3,OwnerAuthid,35)
		Price = array_get_int(CurArray,4)
		Locked = array_get_int(CurArray,5)
		Access = array_get_int(CurArray,6)
		Profit = array_get_int(CurArray,7)	
		
		ARP_SqlEscape(InternalName,63)
		ARP_SqlEscape(ExternalName,63)
		ARP_SqlEscape(OwnerName,32)
		ARP_SqlEscape(OwnerAuthid,35)
		//replace_all(ExternalName,32,"'","\'")
		//replace_all(OwnerName,32,"'","\'")
		
		ARP_IntToAccess(Access,AccessStr,JOB_ACCESSES)
		
		#if defined DEBUG
		g_TotalQueries++
		#endif
		
		switch(g_SqlMode)
		{
			case MYSQL:
				format(g_Query,4095,"INSERT INTO %s VALUES ('%s','%s','%s','%s','%d','%d','%s','%d') ON DUPLICATE KEY UPDATE externalname='%s',ownername='%s',ownerauth='%s',price='%d',locked='%d',access='%s',profit='%d'",g_PropertyTable,InternalName,ExternalName,OwnerName,OwnerAuthid,Price,Locked,AccessStr,Profit,ExternalName,OwnerName,OwnerAuthid,Price,Locked,AccessStr,Profit)
			case SQLITE:
				format(g_Query,4095,"INSERT OR REPLACE INTO %s VALUES ('%s','%s','%s','%s','%d','%d','%s','%d')",g_PropertyTable,InternalName,ExternalName,OwnerName,OwnerAuthid,Price,Locked,AccessStr,Profit)
		}
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	}
	
	for(new Count;Count < g_DoorNum;Count++)
	{
		CurArray = array_get_int(g_DoorArray,Count)
		
		Changed = array_get_int(CurArray,3)
		if(!Changed)
			continue
		
		array_get_string(CurArray,0,Targetname,32)
		EntID = array_get_int(CurArray,1)
		array_get_string(CurArray,2,InternalName,32)
		
		EntID ? format(Targetname,32,"e|%d",EntID) : format(Targetname,32,"t|%s",Targetname)
		
		#if defined DEBUG
		g_TotalQueries++
		#endif
		
		ARP_SqlEscape(InternalName,charsmax(InternalName))
		ARP_SqlEscape(Targetname,32)
		
		switch(g_SqlMode)
		{
			case MYSQL:
				format(g_Query,4095,"INSERT INTO %s VALUES ('%s','%s') ON DUPLICATE KEY UPDATE internalname='%s'",g_DoorsTable,Targetname,InternalName,InternalName)
			case SQLITE:
				format(g_Query,4095,"INSERT OR REPLACE INTO %s VALUES ('%s','%s')",g_DoorsTable,Targetname,InternalName)
		}
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	}
		
	new Float:Performance = get_pcvar_float(p_Performance)
	
	// epsilon format for IEEE precision (if it's 0)
	if(Performance > 0.1)
		set_task(get_pcvar_float(p_SaveTime) * Performance / 100.0,"SaveData")
}

SaveUserItems(id)
{
	new Authid[72],ItemId,ItemName[33],Size = array_size(g_UserItemArray[id]) + 1
	
	if(Size < 2)
		return
	
	SQL_QuoteString(Empty_Handle,Authid,charsmax(Authid),g_CharKey[id])
	
	for(new Count = 1,Success = 1;Count < Size && Success;Count++)
	{
		ItemId = array_get_nth(g_UserItemArray[id],Count,_,Success)
		if(ItemId < 1 || !Success)
			continue
		
		UTIL_ARP_GetItemName(ItemId,ItemName,32)
		
		new Num = array_get_int(g_UserItemArray[id],ItemId)
		if(Num < 1)
			continue
		
		#if defined DEBUG
		g_TotalQueries++
		#endif
		
		ARP_SqlEscape(ItemName,32)
		//replace_all(ItemName,32,"'","\'")
		
		//format(g_Query,511,"IF EXISTS (SELECT * FROM %s WHERE authid='%s' AND itemid='%d')^nUPDATE %s SET num='%d' WHERE authid='%s' AND itemid='%d'^nELSE^nINSERT INTO %s VALUES('%s','%d','%d')",g_ItemsTable,Authid,ItemId,g_ItemsTable,Num,Authid,ItemId,g_ItemsTable,Authid,ItemId,Num)
		switch(g_SqlMode)
		{
			case MYSQL:
				format(g_Query,4095,"INSERT INTO %s VALUES('%s|%s','%d') ON DUPLICATE KEY UPDATE num='%d'",g_ItemsTable,Authid,ItemName,abs(Num),abs(Num))
			case SQLITE:
				format(g_Query,4095,"INSERT OR REPLACE INTO %s VALUES('%s|%s','%d')",g_ItemsTable,Authid,ItemName,abs(Num))
		}
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
		
		Num = -abs(Num)
		
		//format(g_Query,511,"SELECT * FROM %s WHERE authid='%s' AND itemid='%d'",g_ItemsTable,Authid,ItemId)
		//UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"SaveClientItems",g_Query,Data,3)
		//Id = array_get_int(array_get_int(g_UserItemArray[id],Count + 1),1)
		//Num = array_get_int(array_get_int(g_UserItemArray[id],Count + 1),2)
		
		//if(Id && Num)
		//	Pos += format(Items[Pos],511,"%d|%d ",Id,Num)
	}
	
	//if(g_PluginEnd)
	//	array_destroy(g_UserItemArray[id])
}

public PlayerTouch(Touched,Toucher)
{
	if(get_pcvar_num(p_Performance) < 70)
		return PLUGIN_CONTINUE		
	
	new Result = CheckTouched(Touched)
	if(Result)
		return RunResult(Result,Touched,Toucher)
	
	Result = CheckTouched(Toucher)
	if(Result)
		return RunResult(Result,Touched,Toucher)
	
	return PLUGIN_CONTINUE
}

RunResult(Result,Touched,Toucher)
{
	switch(Result)
	{
		case 1 :
		{
			if(is_user_alive(Touched))
			{
				force_use(Touched,Toucher)
				fake_touch(Toucher,Touched)
			}
			else if(is_user_alive(Toucher))
			{
				force_use(Toucher,Touched)
				fake_touch(Touched,Toucher)
			}
		}
		case 2 :
			return PLUGIN_HANDLED
	}
	
	return PLUGIN_CONTINUE
}

CheckTouched(Index)
{
	new Classname[33]
	entity_get_string(Index,EV_SZ_classname,Classname,32)
	
	if(equali(Classname,"func_door") || equali(Classname,"func_door_rotating"))
	{
		static Targetname[33],CurTargetname[33]
		entity_get_string(Index,EV_SZ_targetname,CurTargetname,32)
		
		for(new Count,Property;Count < g_DoorNum;Count++)
		{			
			array_get_string(array_get_int(g_DoorArray,Count),0,Targetname,32)
			if((CurTargetname[0] && Targetname[0] && equali(Targetname,CurTargetname)) || (array_isfilled(array_get_int(g_DoorArray,Count),1) && Index == array_get_int(array_get_int(g_DoorArray,Count),1) && is_valid_ent(Index)))
			{				
				Property = UTIL_ARP_GetProperty(Targetname,Index)
				if(Property == -1)
					return PLUGIN_CONTINUE
				
				return array_get_int(array_get_int(g_PropertyArray,Property),5) + 1
			}
		}
	}
	
	return PLUGIN_CONTINUE
}

public plugin_precache()
{	
	g_Plugin = register_plugin("ARP - Core",g_Version,"The Apollo RP Team")
	
	p_StartMoney = register_cvar("arp_startmoney","500")
	p_ItemsPerPage = register_cvar("arp_items_per_page","30")
	p_SaveTime = register_cvar("arp_save_interval","30")
	p_Lights = register_cvar("arp_lights","q")
	p_GodDoors = register_cvar("arp_goddoors","1")
	p_GodWindows = register_cvar("arp_godwindows","0")
	p_FallDamage = register_cvar("arp_falldamage","1")
	p_AuxType = register_cvar("arp_hud4_type","1")
	p_Performance = register_cvar("arp_performance","100")
	p_Log = register_cvar("arp_log","1")
	p_GameName = register_cvar("arp_gamename","")
	p_HoverMessage = register_cvar("arp_hover_message","1")
	// H9: 1 names a dropped item the player looks toward (H9_AimedItem); 0 is stock ARP, which says nothing of it
	p_H9ItemHover = register_cvar("arp_h9_itemhover","1")
	// H9: 1 shows the picture of a dropped item over its pack (H9_ItemIconMake); 0 is stock ARP. arp_h9_itemicon_max is the most icons that stand at a time (the oldest makes way; 0
	// makes none), arp_h9_itemicon_scale the size of one (1.0 is 32 units across)
	p_H9ItemIcon = register_cvar("arp_h9_itemicon","1")
	p_H9ItemIconMax = register_cvar("arp_h9_itemicon_max","64")
	p_H9ItemIconScale = register_cvar("arp_h9_itemicon_scale","0.6")
	// H9: 1 makes a pack that has just been dropped glow, a purple point light over it that pulses every second and a half, so that it shows in a dark corner and is easy to find and pick up
	// (H9_ItemGlowStart); 0 is stock ARP, which gives the pack no light. arp_h9_itemglow_time is the seconds it glows for after the drop (0 to 600; 0 gives none), arp_h9_itemglow_radius how far
	// the light reaches (units, 40 to 600) and arp_h9_itemglow_color its colour (red green blue, 0 to 255 each)
	p_H9ItemGlow = register_cvar("arp_h9_itemglow","1")
	p_H9ItemGlowTime = register_cvar("arp_h9_itemglow_time","12")
	p_H9ItemGlowRadius = register_cvar("arp_h9_itemglow_radius","200")
	p_H9ItemGlowColor = register_cvar("arp_h9_itemglow_color","180 60 255")
	// H9: what Apollo RP prints in chat (the lines that start with [ARP]) as a popup over the crosshair that fades, to the games that draw H9 panels:
	// 0 chat as stock ARP, 1 the popup in place of the chat line, 2 both
	p_Toast = register_cvar("arp_h9_toast","1")
	// H9: what a player looks at (a property door, an NPC, a player) says what it is: the establishment, its owner or that it is for sale, its affiliation
	// (from the access letters), whether it is locked and whether the player may use it. A game that draws the HUD as panels (arp_hud4_type 2) gets a plaque
	// panel, every other game the text with an Affiliation line. 0 is stock ARP's text.
	p_H9Plaque = register_cvar("arp_h9_plaque","1")
	// H9: 1 sends the HUD as a panel to the games that draw it, 0 sends everyone the text HUD; the seconds before a HUD that
	// has not changed is sent again (5 to 60)
	p_HudPanel = register_cvar("arp_hud_panel","1")
	p_HudRefresh = register_cvar("arp_hud_refresh","10")
	// H9: seconds a join may wait for a havoc9.org account (arp_ids); 0: no account is waited for, used or recorded
	p_AcctWait = register_cvar("arp_account_wait","30")
	// H9: 1 runs the map's own SQL file (configs/arp/maps/<map>/<map>.sql) at map start when every statement in it can be run
	// again and again; 0 leaves it to arp_config, entry 3
	p_MapSqlAuto = register_cvar("arp_mapsql_autoload","1")
	//p_CharacterSheet = register_cvar("arp_character_sheet","1")
	
	p_Welcome[0] = register_cvar("arp_welcome_msg1","This server is running Apollo RP (http://ApolloRP.org).")
	p_Welcome[1] = register_cvar("arp_welcome_msg2","Type ^"arp_help^" in your console to get started.")
	p_Welcome[2] = register_cvar("arp_welcome_msg3","")
	
	for(new Count,Cvar[33];Count < HUD_NUM;Count++)
	{
		format(Cvar,32,"arp_hud%d_x",Count + 1)
		p_Hud[Count][X] = register_cvar(Cvar,"")
		
		format(Cvar,32,"arp_hud%d_y",Count + 1)
		p_Hud[Count][Y] = register_cvar(Cvar,"")
		
		format(Cvar,32,"arp_hud%d_r",Count + 1)
		p_Hud[Count][R] = register_cvar(Cvar,"")
		
		format(Cvar,32,"arp_hud%d_g",Count + 1)
		p_Hud[Count][G] = register_cvar(Cvar,"")
		
		format(Cvar,32,"arp_hud%d_b",Count + 1)
		p_Hud[Count][B] = register_cvar(Cvar,"")
	}
	
	p_WalletDeath = register_cvar("arp_wallet_death","1")
	/*p_AuxType = register_cvar("arp_auxhud_type","2")
	p_AuxX = register_cvar("arp_auxhud_x","0.4")
	p_AuxY = register_cvar("arp_auxhud_y","0.7")
	p_AuxR = register_cvar("arp_auxhud_r","255")
	p_AuxG = register_cvar("arp_auxhud_g","0")
	p_AuxB = register_cvar("arp_auxhud_b","0")*/
	
	register_cvar(g_HostCvar,"")
	register_cvar(g_UserCvar,"")
	register_cvar(g_PassCvar,"")
	register_cvar(g_DbCvar,"")
	register_cvar(g_TypeCvar,"")
	
	register_cvar(g_PoliceAccessCvar,"a")
	register_cvar(g_MedicalAccessCvar,"b")
	register_cvar(g_AdminAccessCvar,"z")

	// H9: the access letters of the Insurgency's jobs and properties. The Affiliation line of the look-at plaque says Insurgency for a player whose job
	// holds one and for a door whose property lists one; a job with the police letter, the medical letter or g says Middle Sea Republic.
	register_cvar(g_H9InsurgentAccessCvar,"i")
	
	// H9: team play (docs\APOLLO_RP.txt, 10). arp_teamplay 1 puts a roleplay map on TS's team rules with three teams (g_H9TeamNames: the Middle Sea Republic, the Insurrection
	// and the Proletarians), and each player on the team of his job; 0 is stock ARP, which never touches a team. arp_teamplay_on is ARP_TS's word that TS reports the three teams on this
	// map: it is 0 until then and on every map afresh. game.cfg runs the command h9_arp_teams after its team lines of the match mode; it is registered here, before the
	// roleplay test, so that it exists on every map and game.cfg never meets an unknown command (a map that does not ask for team play leaves it a no-op).
	p_H9Teamplay = register_cvar("arp_teamplay","0")
	p_H9TeamplayOn = register_cvar("arp_teamplay_on","0",FCVAR_SPONLY)
	set_pcvar_num(p_H9TeamplayOn,0)
	register_srvcmd("h9_arp_teams","H9_TeamsHook")
	
	// H9: Apollo RP plays on roleplay maps only. On any other map every ARP plugin stands down
	// here, before its precache, its init and every hook: no config, no database, no player data.
	if(!H9_RoleplayMap())
	{
		H9_StandDown()
		return
	}
	
	H9_TeamsPrecache()
	
	arpvgui_precache()
	
	// H9: variable length (-1), registered here so every game learns it as it joins
	g_HudMsg = engfunc(EngFunc_RegUserMsg,"H9ArpHud",-1)
	
	new MapName[33],ConfigFile[128]
	
	get_configsdir(ConfigFile,127)
	add(ConfigFile,127,"/arp/arp.ini")
	
	get_mapname(MapName,sizeof MapName - 1)
	get_configsdir(g_Query,sizeof g_Query - 1)
	format(g_ConfigsDir,sizeof g_ConfigsDir - 1,"%s/arp/maps/%s",g_Query,MapName)
	
	if(!dir_exists(g_ConfigsDir))
	{
		format(g_Query,sizeof g_Query - 1,"Configuration directory missing: %s",g_ConfigsDir)
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}

	new File = fopen(ConfigFile,"r")
	if(!File)
	{
		format(g_Query,4095,"Could not open core config file (%s).",ConfigFile)
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}

	LoadConfigFile(File)

	format(ConfigFile,127,"%s/arp.ini",g_ConfigsDir)
	if(file_exists(ConfigFile))
	{
		File = fopen(ConfigFile,"r")
		if(File)
			LoadConfigFile(File)
	}
	
	// H9: a map's properties, doors and keys are its own. Their tables carry the map's name
	// (arp_property_<map>, arp_doors_<map>, arp_keys_<map>), so one database serves every
	// roleplay map; players, jobs, items and data stay shared.
	H9_MapTable(g_PropertyTable,sizeof g_PropertyTable)
	H9_MapTable(g_DoorsTable,sizeof g_DoorsTable)
	H9_MapTable(g_KeysTable,sizeof g_KeysTable)

	if(file_exists(g_ItemModel))
		precache_model(g_ItemModel)
	else
	{
		format(g_Query,sizeof g_Query - 1,"Item model missing: %s",g_ItemModel)
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}

	H9_ItemIconPrecache()
	
	g_ItemsArray = array_create()
	
	for(new Count;Count <= MAX_PLAYERS;Count++)
	{
		g_MenuArray[Count] = TravTrieCreate()
		//g_Characters[Count] = TravTrieCreate()
		g_UserItemArray[Count] = array_create()
		for(new Count2;Count2 < HUD_NUM;Count2++)
			g_HudArray[Count][Count2] = TravTrieCreate(256,_)
		//g_HudArray[Count] = TravTrieCreate()
		
		g_SpeedTrie[Count] = TravTrieCreate()
	}
	
	g_JobsArray = array_create()
	g_CommandArray = array_create()
	g_PropertyArray = array_create()
	g_DoorArray = array_create()
	g_ClassArray = TravTrieCreate()
	g_EventTrie = TravTrieCreate()
	g_PluginTrie = TravTrieCreate()
	
	g_RegisterItem = 1
	
	new Forward = CreateMultiForward("ARP_RegisterItems",ET_IGNORE),Return
	if(!Forward || !ExecuteForward(Forward,Return))
		UTIL_ARP_ThrowError(0,0,"Could not execute ^"ARP_RegisterItems^" forward.",0)
	DestroyForward(Forward)
		
	g_RegisterItem = 0
	
	SqlInit()
}

// H9: a roleplay map by its name, the rule of ts_matchmode's roleplay_map() and of
// tsrp_roambots: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ inside it, in any case.
bool:H9_RoleplayMap()
{
	new MapName[64]
	get_mapname(MapName,sizeof MapName - 1)
	
	return equali(MapName,"rp_",3) || equali(MapName,"tsrp_",5) || containi(MapName,"_rp_") != -1 || containi(MapName,"_tsrp_") != -1
}

// The map's team list as TS reads mp_teamlist: the names of g_H9TeamNames in the order of the numbers, ";" between them.
H9_TeamList(List[],Len)
{
	List[0] = 0
	
	for(new Team = ARP_H9_TEAM_FIRST;Team <= ARP_H9_TEAMS;Team++)
	{
		if(Team > ARP_H9_TEAM_FIRST)
			add(List,Len,";")
		
		add(List,Len,g_H9TeamNames[Team])
	}
}

// H9: the game's half of team play, on a roleplay map. The world spawns right after this precache, and TS decides then, from mp_teamplay, whether teams work at all; it
// reads its team list as it makes its rules, straight after game.cfg (H9_TeamsHook writes it there). arp_teamplay 1 in arp.cfg or the map's mapconfig, on a game that has
// the TS modules, makes the map a team map (ts_matchmode, which precaches first, has set mp_teamplay for the map's name already) and keeps TS from ever writing a
// player's model (mp_teammodels_force 0, reTS: reference\DEVIATIONS.md), so that each keeps the model he chose whatever team he joins. The server runs both files only after
// this precache, so h9_teams_requested reads them.
H9_TeamsPrecache()
{
	g_H9TeamsAsked = false
	
	if(!h9_teams_requested())
		return
	
	// a mapconfig that says mp_teamplay 0 keeps the map off team rules, as it does for ts_matchmode
	if(h9_mapcfg_num("mp_teamplay",1) == 0)
	{
		log_amx("[ARP] arp_teamplay is 1, but this map's mapconfig says mp_teamplay 0: team play stays off.")
		return
	}
	
	if(!module_exists("tsfun") && !module_exists("tsx"))
	{
		log_amx("[ARP] arp_teamplay is 1, but this game is not The Specialists: team play stays off.")
		return
	}
	
	g_H9TeamsAsked = true
	
	set_cvar_num("mp_teamplay",1)
	if(cvar_exists("teamplay"))
		set_cvar_num("teamplay",1)
	if(cvar_exists("mp_teammodels_force"))
		set_cvar_num("mp_teammodels_force",0)
	
	new List[128]
	H9_TeamList(List,charsmax(List))
	
	log_amx("[ARP] arp_teamplay is 1: this map plays on TS's team rules (mp_teamplay 1) with the teams %s; each player is put on the team of his job once TS reports them.",List)
}

// H9: the server command h9_arp_teams, which ts\game.cfg runs after the match mode's team lines. With team play asked for it writes ARP's three teams as the map's team
// list, and friendly fire on: the list is read when TS makes its rules, straight after game.cfg, so no other place can change it, and game.cfg sets mp_friendlyfire 0
// (ARP_TS sets both again for the first minute of the map, after the server's other files have run). Anywhere else it does nothing.
public H9_TeamsHook()
{
	if(!g_H9TeamsAsked)
		return
	
	new List[128]
	H9_TeamList(List,charsmax(List))
	
	set_cvar_string("mp_teamlist",List)
	set_cvar_num("mp_friendlyfire",1)
	if(cvar_exists("mp_teammodels_force"))
		set_cvar_num("mp_teammodels_force",0)
	
	log_amx("[ARP] game.cfg ran h9_arp_teams: mp_teamlist is ^"%s^", mp_friendlyfire 1.",List)
}

// H9: off a roleplay map, every loaded ARP plugin (ARP_*.amxx) is paused, this core last.
// A paused plugin stays loaded and gets no forward, hook, command or task, so none of
// them touches the map, the database or a player; the next map loads them all afresh.
H9_StandDown()
{
	new MapName[64],Own[64],File[64],Temp[2],Paused
	get_mapname(MapName,sizeof MapName - 1)
	get_plugin(-1,Own,sizeof Own - 1,Temp,1,Temp,1,Temp,1,Temp,1)
	
	for(new Plugin = get_pluginsnum() - 1;Plugin >= 0;Plugin--)
	{
		get_plugin(Plugin,File,sizeof File - 1,Temp,1,Temp,1,Temp,1,Temp,1)
		if(equali(File,"ARP_",4) && !equali(File,Own))
		{
			pause("ac",File)
			Paused++
		}
	}
	
	log_amx("[ARP] %s is not a roleplay map: Apollo RP stands down (%d ARP plugins paused, and the core).",MapName,Paused)
	
	pause("a")
}

// H9: the map's own name added to a table's: "_" and the name, lower case, with anything but
// letters and digits as "_".
H9_MapTable(Table[],Len)
{
	new MapName[64],Suffix[66]
	get_mapname(MapName,sizeof MapName - 1)
	
	Suffix[0] = '_'
	for(new Count,Char;MapName[Count];Count++)
	{
		Char = tolower(MapName[Count])
		Suffix[Count + 1] = ((Char >= 'a' && Char <= 'z') || (Char >= '0' && Char <= '9')) ? Char : '_'
	}
	
	add(Table,Len - 1,Suffix)
}

// H9: a property's key holders, a bit for each player slot, 32 to a cell: slots 1 to 32 in its cell
// 8, as upstream kept them all, and each further 32 in cell H9_KEY_CELLS + 1 on (slots 33 to 64 in
// 101, and so on), so that a player past slot 32 holds no other player's keys. A cell never written
// is no keys.
#define H9_KEY_CELLS 100
#define H9_KEY_WORDS ((MAX_PLAYERS + 31) / 32)

H9_KeyCell(Word)
	return Word ? H9_KEY_CELLS + Word : 8

H9_HasKey(CurArray,id)
{
	new Cell = H9_KeyCell((id - 1) / 32)
	return array_isfilled(CurArray,Cell) && (array_get_int(CurArray,Cell) & (1<<((id - 1) % 32)))
}

H9_SetKey(CurArray,id,Has)
{
	new Cell = H9_KeyCell((id - 1) / 32),Bit = 1<<((id - 1) % 32)
	new Bits = array_isfilled(CurArray,Cell) ? array_get_int(CurArray,Cell) : 0
	array_set_int(CurArray,Cell,Has ? (Bits | Bit) : (Bits & ~Bit))
}

H9_ClearKeys(CurArray)
	for(new Word;Word < H9_KEY_WORDS;Word++)
		array_set_int(CurArray,H9_KeyCell(Word),0)

H9_AnyKeys(CurArray)
{
	for(new Word,Cell;Word < H9_KEY_WORDS;Word++)
	{
		Cell = H9_KeyCell(Word)
		if(array_isfilled(CurArray,Cell) && array_get_int(CurArray,Cell))
			return 1
	}
	return 0
}

H9_CopyKeys(To,From)
	for(new Word,Cell;Word < H9_KEY_WORDS;Word++)
	{
		Cell = H9_KeyCell(Word)
		array_set_int(To,Cell,array_isfilled(From,Cell) ? array_get_int(From,Cell) : 0)
	}

LoadConfigFile(File)
{
	new ConfigFile[128],Left[128],Right[128]
	
	while(!feof(File))
	{
		// bad naming application, but whatever
		fgets(File,ConfigFile,sizeof ConfigFile - 1)
		trim(ConfigFile)
		
		if(ConfigFile[0] == ';')
			continue
		
		parse(ConfigFile,Left,sizeof Left - 1,Right,sizeof Right - 1)
		remove_quotes(Left)
		trim(Left)
		remove_quotes(Right)
		trim(Right)
		
		if(Left[0] && Right[0])
		{
			if(equali(Left,g_HostCvar))
			{
				set_cvar_string(g_HostCvar,Right)
				copy(g_Host,sizeof g_Host - 1,Right)
			}
			else if(equali(Left,g_UserCvar))
			{
				set_cvar_string(g_UserCvar,Right)
				copy(g_User,sizeof g_User - 1,Right)
			}
			else if(equali(Left,g_PassCvar))
			{
				set_cvar_string(g_PassCvar,Right)
				copy(g_Pass,sizeof g_Pass - 1,Right)
			}
			else if(equali(Left,g_DbCvar))
			{
				set_cvar_string(g_DbCvar,Right)
				copy(g_Db,sizeof g_Db - 1,Right)
			}
			else if(equali(Left,g_TypeCvar))
			{
				set_cvar_string(g_TypeCvar,Right)
				copy(g_Type,sizeof g_Type - 1,Right)
			}
			else if(equali(Left,"arp_table_users"))
				copy(g_UserTable,sizeof g_UserTable - 1,Right)
			else if(equali(Left,"arp_table_jobs"))
				copy(g_JobsTable,sizeof g_JobsTable - 1,Right)
			else if(equali(Left,"arp_table_property"))
				copy(g_PropertyTable,sizeof g_PropertyTable - 1,Right)
			else if(equali(Left,"arp_table_doors"))
				copy(g_DoorsTable,sizeof g_DoorsTable - 1,Right)
			else if(equali(Left,"arp_table_keys"))
				copy(g_KeysTable,sizeof g_KeysTable - 1,Right)
			else if(equali(Left,"arp_table_items"))
				copy(g_ItemsTable,sizeof g_ItemsTable - 1,Right)
		}
	}
	
	fclose(File)
}

// H9: a map's own SQL file, configs/arp/maps/<map>/<map>.sql, is run at map start (LoadMapSql), after the tables are made and
// before the jobs, properties and doors are read, so its rows are there in the same map load and nobody runs arp_config. It
// is run only when every statement in it can be run again and again; any other file is left to arp_config, entry 3, and the
// log says why. The rule, for each line (a blank line and a line that starts with - ; or # are passed over):
//     INSERT OR IGNORE INTO <table> VALUES (...);
// <table> is arp_jobs, arp_property or arp_doors, in lower case, and the map's own table takes its place; the name of an
// ARP table comes up nowhere else in the statement. One statement to a line of at most 1000 characters, nothing after its
// ";" (which may be left off), no other ";", no comment, no quoted name, every ' closed; at most 4000 statements.
#define H9_MAPSQL_LINE 1000
#define H9_MAPSQL_MAX 4000
#define H9_MAPSQL_JOBS 1
#define H9_MAPSQL_PROPERTY 2
#define H9_MAPSQL_DOORS 3

new g_MapSqlAsk			// statements handed to the database
new g_MapSqlGot			// statements it has answered
new g_MapSqlErr			// answers that were errors
new bool:g_MapSqlSent		// every statement has been handed over
new bool:g_MapSqlLogged		// the line for this map has been written

// The next statement line of the file in Line, trimmed: 1 a line, 0 the end of the file, -1 a line too long to be a statement.
// Number counts the lines read.
H9_MapSqlRead(File,Line[],Len,&Number)
{
	while(!feof(File))
	{
		Line[0] = 0
		fgets(File,Line,Len)
		Number++

		new Last = strlen(Line) - 1
		if(Last >= Len - 1 && Line[Last] != '^n')
			return -1

		trim(Line)
		if(strlen(Line) > H9_MAPSQL_LINE)
			return -1

		if(Line[0] == ';' || Line[0] == '#' || Line[0] == '-' || strlen(Line) < 3)
			continue

		return 1
	}

	return 0
}

// Is Line a statement the rule allows? The table it adds to (H9_MAPSQL_JOBS, _PROPERTY or _DOORS), or 0 with what is wrong with
// it in Why. After is where the statement goes on after the table's name.
H9_MapSqlCheck(const Line[],Why[],WhyLen,&After)
{
	static const Prefix[] = "INSERT OR IGNORE INTO "
	static const Targets[][] = {"arp_jobs","arp_property","arp_doors"}
	static const Names[][] = {"arp_users","arp_jobs","arp_property","arp_doors","arp_keys","arp_items","arp_data"}

	if(!equali(Line,Prefix,charsmax(Prefix)))
	{
		copy(Why,WhyLen,"is not an INSERT OR IGNORE INTO statement")
		return 0
	}

	new Table,Count
	for(Count = 0;Count < sizeof Targets && !Table;Count++)
	{
		After = charsmax(Prefix) + strlen(Targets[Count])
		if(equal(Line[charsmax(Prefix)],Targets[Count],strlen(Targets[Count])) && equali(Line[After]," VALUES",7) && (Line[After + 7] == ' ' || Line[After + 7] == '('))
			Table = Count + 1
	}

	if(!Table)
	{
		copy(Why,WhyLen,"does not add VALUES to arp_jobs, arp_property or arp_doors (lower case)")
		return 0
	}

	for(Count = 0;Count < sizeof Names;Count++)
		if(containi(Line[After],Names[Count]) != -1)
		{
			copy(Why,WhyLen,"names a table of ARP's a second time")
			return 0
		}

	new Len = strlen(Line),bool:Text
	for(Count = After;Count < Len;Count++)
	{
		if(Line[Count] == 39)
		{
			Text = !Text
			continue
		}

		if(Text)
			continue

		if(Line[Count] == ';' && Count < Len - 1)
		{
			copy(Why,WhyLen,"has a semicolon before its end")
			return 0
		}

		if(Line[Count] == '"' || Line[Count] == '`')
		{
			copy(Why,WhyLen,"quotes a name")
			return 0
		}

		if((Line[Count] == '-' && Line[Count + 1] == '-') || (Line[Count] == '/' && Line[Count + 1] == '*'))
		{
			copy(Why,WhyLen,"has a comment in it")
			return 0
		}
	}

	if(Text)
	{
		copy(Why,WhyLen,"has a quote that is never closed")
		return 0
	}

	return Table
}

// The statement to run for a line that passed H9_MapSqlCheck: this map's own table in the place of the default one, and the
// closing ";" left off.
H9_MapSqlBuild(const Line[],Table,After,Statement[],Len)
{
	new Name[64]

	switch(Table)
	{
		case H9_MAPSQL_JOBS:
			copy(Name,sizeof Name - 1,g_JobsTable)
		case H9_MAPSQL_PROPERTY:
			copy(Name,sizeof Name - 1,g_PropertyTable)
		default:
			copy(Name,sizeof Name - 1,g_DoorsTable)
	}

	format(Statement,Len,"INSERT OR IGNORE INTO %s%s",Name,Line[After])

	new Last = strlen(Statement) - 1
	if(Statement[Last] == ';')
		Statement[Last] = 0
}

// Whether the map's SQL file is to be run: arp_mapsql_autoload as arp.cfg sets it. This plugin reads arp.cfg itself for it,
// because the server executes that file only after this plugin's precache, so on a server's first map the cvar is still its
// default here; when arp.cfg does not name it, the cvar as it stands is the answer.
H9_MapSqlWanted()
{
	new Wanted = get_pcvar_num(p_MapSqlAuto),Path[128]
	get_configsdir(Path,sizeof Path - 1)
	add(Path,sizeof Path - 1,"/arp/arp.cfg")

	new Fp = fopen(Path,"r")
	if(!Fp)
		return Wanted

	new Line[256],Left[48],Right[16]
	while(!feof(Fp))
	{
		Line[0] = 0
		fgets(Fp,Line,sizeof Line - 1)
		trim(Line)

		if(!Line[0] || Line[0] == '/' || Line[0] == ';')
			continue

		Left[0] = 0
		Right[0] = 0
		parse(Line,Left,sizeof Left - 1,Right,sizeof Right - 1)

		if(equali(Left,"arp_mapsql_autoload"))
			Wanted = str_to_num(Right)
	}

	fclose(Fp)

	return Wanted
}

// Runs the map's SQL file. The whole file is read against the rule first and a file with one line the rule does not allow is
// not run at all; then every statement goes to the database in the file's order. With nobody in the game each runs in line and
// its answer is in before the next goes; with players the module's one worker keeps the order, so the reads in SqlInit see the
// rows, and the answers, which come back in any order, are only counted (MapSqlAnswer, H9_MapSqlReport).
LoadMapSql()
{
	if(g_SqlHandle == Empty_Handle)
		return

	new MapName[64],Path[160]
	get_mapname(MapName,sizeof MapName - 1)
	format(Path,sizeof Path - 1,"%s/%s.sql",g_ConfigsDir,MapName)

	if(!file_exists(Path))
	{
		log_amx("[ARP] map SQL: none, %s is not there.",Path)
		return
	}

	if(!H9_MapSqlWanted())
	{
		log_amx("[ARP] map SQL: %s.sql is not run, arp_mapsql_autoload is 0 (arp_config, entry 3, runs it by hand).",MapName)
		return
	}

	if(g_SqlMode != SQLITE)
	{
		log_amx("[ARP] map SQL: %s.sql is not run, the database is not SQLite (arp_config, entry 3, runs it by hand).",MapName)
		return
	}

	static Line[H9_MAPSQL_LINE + 100],Statement[H9_MAPSQL_LINE + 200],Why[128],Bad[256]
	new Fp = fopen(Path,"r"),Read,Number,Table,After,Statements

	if(!Fp)
	{
		log_amx("[ARP] map SQL: %s could not be opened.",Path)
		return
	}

	Bad[0] = 0
	while(!Bad[0] && (Read = H9_MapSqlRead(Fp,Line,sizeof Line - 1,Number)) != 0)
	{
		if(Read < 0)
			format(Bad,sizeof Bad - 1,"line %d is longer than %d characters",Number,H9_MAPSQL_LINE)
		else if(!H9_MapSqlCheck(Line,Why,sizeof Why - 1,After))
		{
			Line[60] = 0
			format(Bad,sizeof Bad - 1,"line %d (%s) %s",Number,Line,Why)
		}
		else if(++Statements > H9_MAPSQL_MAX)
			format(Bad,sizeof Bad - 1,"it has more than %d statements",H9_MAPSQL_MAX)
	}
	fclose(Fp)

	if(Bad[0])
	{
		log_amx("[ARP] map SQL: %s.sql is not run: %s. arp_config, entry 3, runs it by hand.",MapName,Bad)
		return
	}

	Fp = fopen(Path,"r")
	if(!Fp)
	{
		log_amx("[ARP] map SQL: %s could not be opened.",Path)
		return
	}

	new Data[1]

	Number = 0
	while(H9_MapSqlRead(Fp,Line,sizeof Line - 1,Number) > 0)
	{
		Table = H9_MapSqlCheck(Line,Why,sizeof Why - 1,After)
		if(!Table)
			continue

		H9_MapSqlBuild(Line,Table,After,Statement,sizeof Statement - 1)

		Data[0] = Number
		g_MapSqlAsk++
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"MapSqlAnswer",Statement,Data,1)
	}
	fclose(Fp)

	g_MapSqlSent = true
}

public MapSqlAnswer(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	g_MapSqlGot++

	if(FailState != TQUERY_SUCCESS || Errcode)
	{
		g_MapSqlErr++
		log_amx("[ARP] map SQL: line %d failed: %s",DataSize ? Data[0] : 0,Error)
	}

	H9_MapSqlReport()

	return PLUGIN_CONTINUE
}

// The one line for this map's load, once every statement has been handed over and answered. SqlInit asks for it after the reads
// too, so that the jobs, properties and doors it names are the ones read after the file.
H9_MapSqlReport()
{
	if(!g_MapSqlSent || g_MapSqlLogged || g_MapSqlGot < g_MapSqlAsk)
		return

	g_MapSqlLogged = true
	log_amx("[ARP] map SQL: %d statements, %d errors, jobs now %d, properties now %d, doors now %d",g_MapSqlAsk,g_MapSqlErr,g_JobsNum,g_PropertyNum,g_DoorNum)
}

public SqlInit()
{
	new Type[64]
	SQL_GetAffinity(Type,sizeof Type - 1)
	
	if(!equali(Type,g_Type) && !SQL_SetAffinity(g_Type))
	{
		format(g_Query,sizeof g_Query - 1,"Failed to set SQL affinity from %s to %s.",Type,g_Type)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(equali(g_Type,"mysql")) g_SqlMode = MYSQL
	else if(equali(g_Type,"sqlite")) g_SqlMode = SQLITE
	
	g_SqlHandle = SQL_MakeDbTuple(g_Host,g_User,g_Pass,g_Db)
	if(g_SqlHandle == Empty_Handle)
	{
		format(g_Query,4095,"Failed to create SQL tuple.")
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	new ErrorCode,Handle:SqlConnection = SQL_Connect(g_SqlHandle,ErrorCode,g_Query,4095)
	if(ErrorCode)
	{
		g_SqlHandle = Empty_Handle
		format(g_Query,4095,"Could not connect to SQL database: %s", g_Query)
		UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	SQL_FreeHandle(SqlConnection)
	
	// one of the problems with the original harbu was authid not
	// being 36 max chars. the max is really 36, not 32.
	
	#if defined DEBUG
	g_TotalQueries += 7
	#endif
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),bankmoney INT(11),wallet INT(11),jobname VARCHAR(36),hunger INT(11),access VARCHAR(27),jobright VARCHAR(27),UNIQUE KEY (authid))",g_UserTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),bankmoney INT(11),wallet INT(11),jobname VARCHAR(36),hunger INT(11),access VARCHAR(27),jobright VARCHAR(27),UNIQUE (authid))",g_UserTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	// H9: which authids belong to which havoc9.org account (ArpKey); a table of its own, no row of the others is changed
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (id INT(11) AUTO_INCREMENT,authid VARCHAR(36),acct INT(11),PRIMARY KEY (id),UNIQUE KEY (authid))",g_IdsTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (id INTEGER PRIMARY KEY AUTOINCREMENT,authid VARCHAR(36),acct INT(11),UNIQUE (authid))",g_IdsTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (name VARCHAR(32),salary INT(11),access VARCHAR(27),UNIQUE KEY (name))",g_JobsTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (name VARCHAR(32),salary INT(11),access VARCHAR(27),UNIQUE (name))",g_JobsTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (internalname VARCHAR(66),externalname VARCHAR(66),ownername VARCHAR(40),ownerauth VARCHAR(36),price INT(11),locked INT(11),access VARCHAR(27),profit INT(11),UNIQUE KEY (internalname))",g_PropertyTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (internalname VARCHAR(66),externalname VARCHAR(66),ownername VARCHAR(40),ownerauth VARCHAR(36),price INT(11),locked INT(11),access VARCHAR(27),profit INT(11),UNIQUE (internalname))",g_PropertyTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (targetname VARCHAR(36),internalname VARCHAR(66),UNIQUE KEY (targetname))",g_DoorsTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (targetname VARCHAR(36),internalname VARCHAR(66),UNIQUE (targetname))",g_DoorsTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authidkey VARCHAR(64),UNIQUE KEY (authidkey))",g_KeysTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authidkey VARCHAR(64),UNIQUE (authidkey))",g_KeysTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authidname VARCHAR(64),num INT(11),UNIQUE KEY (authidname))",g_ItemsTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (authidname VARCHAR(64),num INT(11),UNIQUE (authidname))",g_ItemsTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	switch(g_SqlMode)
	{
		case MYSQL:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (classkey VARCHAR(64),value TEXT,UNIQUE KEY (classkey))",g_DataTable)
		case SQLITE:
			format(g_Query,4095,"CREATE TABLE IF NOT EXISTS %s (classkey VARCHAR(64),value TEXT,UNIQUE (classkey))",g_DataTable)
	}
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	// H9: the map's own SQL file, run here so that its rows are in the tables when they are read below
	LoadMapSql()

	format(g_Query,4095,"SELECT * FROM %s",g_JobsTable)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchJobs",g_Query)
	
	format(g_Query,4095,"SELECT * FROM %s",g_PropertyTable)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchProperties",g_Query)
	
	format(g_Query,4095,"SELECT * FROM %s",g_DoorsTable)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchDoors",g_Query)

	H9_MapSqlReport()
	
	new Forward = CreateMultiForward("ARP_Init",ET_IGNORE),Return
	if(Forward <= 0 || !ExecuteForward(Forward,Return))
	{
		format(g_Query,4095,"Could not create ARP_Init forward.")
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	return DestroyForward(Forward)
}

public FetchProperties(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	new InternalName[64],ExternalName[64],OwnerName[33],OwnerAuthid[36],Price,Locked,AccessStr[JOB_ACCESSES + 1],Access,Profit
	if(!SQL_NumResults(Query))
		return PLUGIN_CONTINUE
	
	while(SQL_MoreResults(Query))
	{
		SQL_ReadResult(Query,0,InternalName,63)
		SQL_ReadResult(Query,1,ExternalName,63)
		SQL_ReadResult(Query,2,OwnerName,32)
		SQL_ReadResult(Query,3,OwnerAuthid,35)
		Price = SQL_ReadResult(Query,4)
		Locked = SQL_ReadResult(Query,5)
		SQL_ReadResult(Query,6,AccessStr,JOB_ACCESSES)
		Access = ARP_AccessToInt(AccessStr)
		Profit = SQL_ReadResult(Query,7)
		
		new CurArray = array_create()
		array_set_int(g_PropertyArray,g_PropertyNum++,CurArray)
		
		array_set_string(CurArray,0,InternalName)
		array_set_string(CurArray,1,ExternalName)
		array_set_string(CurArray,2,OwnerName)
		array_set_string(CurArray,3,OwnerAuthid)
		array_set_int(CurArray,4,Price)
		array_set_int(CurArray,5,Locked)
		array_set_int(CurArray,6,Access)
		array_set_int(CurArray,7,Profit)	
		H9_ClearKeys(CurArray)
		array_set_int(CurArray,9,0)
		
		SQL_NextRow(Query)
	}
	
	return PLUGIN_CONTINUE
}

public FetchDoors(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	new Targetname[64],InternalName[64]
	while(SQL_MoreResults(Query))
	{		
		SQL_ReadResult(Query,0,Targetname,63)
		SQL_ReadResult(Query,1,InternalName,63)
		
		new CurArray = array_create()
		array_set_int(g_DoorArray,g_DoorNum,CurArray)
		g_DoorNum++
		
		if(equali(Targetname,"e|",2))
		{
			replace(Targetname,63,"e|","")
			array_set_string(CurArray,0,"")
			array_set_int(CurArray,1,str_to_num(Targetname))	
		}
		else if(equali(Targetname,"t|",2))
		{
			replace(Targetname,63,"t|","")
			array_set_string(CurArray,0,Targetname)
			array_set_int(CurArray,1,0)	
		}
		
		array_set_string(CurArray,2,InternalName)
		array_set_int(CurArray,3,0)
		
		SQL_NextRow(Query)
	}
	
	return PLUGIN_CONTINUE
}

public FetchJobs(FailState,Handle:Query,Error[],Errcode,Data[],DataSize)
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
		
	new Temp[JOB_ACCESSES + 1],CurArray
	while(SQL_MoreResults(Query))
	{
		CurArray = array_create()
		array_set_int(g_JobsArray,g_JobsNum++,CurArray)
		
		SQL_ReadResult(Query,0,g_Query,4095)
		array_set_string(CurArray,1,g_Query)
		
		array_set_int(CurArray,2,SQL_ReadResult(Query,1))
		
		SQL_ReadResult(Query,2,Temp,JOB_ACCESSES)
		array_set_int(CurArray,3,ARP_AccessToInt(Temp))
		
		SQL_NextRow(Query)
	}
	
	// H9: the job every newcomer gets, made when the database has none (a fresh one, on a map no
	// SQL file was loaded for): no player is ever without a job, and no look-up of one reads nothing
	new Results[1]
	if(!ARP_FindJobId("Unemployed",Results,1) || !UTIL_ARP_ValidJobId(Results[0] - 1))
		UTIL_ARP_AddJob("Unemployed",5,0)
	
	return PLUGIN_CONTINUE
}

public plugin_end()
{	
	server_cmd("totaltravtries")
	
	g_PluginEnd = 1
	
	SaveData()
	
	new Players[MAX_PLAYERS],Playersnum
	get_players(Players,Playersnum)
	
	/*
	for(new Count,Count2,Count3,CurArray;Count < Playersnum;Count++)
	{
		id = Players[Count]
		for(Count2 = 0;Count2 < HUD_NUM;Count2++)
		{
			ClearHud(id,Count2)
			for(Count3 = 0;Count3 < g_HudNum[id][Count2];Count3++)
			{
				CurArray = array_get_int(g_HudArray[id][Count2],Count3)
				array_destroy(CurArray)
			}
		}
	}
	*/
	
	for(new Count,Count2;Count <= MAX_PLAYERS;Count++)	
	{
		array_destroy(g_UserItemArray[Count])
		TravTrieDestroy(g_MenuArray[Count])
		//TravTrieDestroy(g_HudArray[Count])
		for(Count2 = 0;Count2 < HUD_NUM;Count2++)
			TravTrieDestroy(g_HudArray[Count][Count2])
	}
	
	new Num
	
	for(new Count;Count < g_CommandNum;Count++)
	{
		Num = array_get_int(g_CommandArray,Count + 1)
		array_destroy(Num)
	}
	
	for(new Count;Count < g_JobsNum;Count++)
	{
		Num = array_get_int(g_JobsArray,Count)
		array_destroy(Num)
	}
	
	for(new Count;Count < g_PropertyNum;Count++)
	{
		Num = array_get_int(g_PropertyArray,Count)
		array_destroy(Num)
	}
	
	for(new Count;Count < g_DoorNum;Count++)
	{
		Num = array_get_int(g_DoorArray,Count)
		array_destroy(Num)
	}
	
	array_destroy(g_JobsArray)
	array_destroy(g_PropertyArray)
	array_destroy(g_CommandArray)
	array_destroy(g_DoorArray)
	//TravTrieDestroy(g_ClassArray)
	array_destroy(g_ItemsArray)
	TravTrieDestroy(g_EventTrie)
	TravTrieDestroy(g_PluginTrie)
		
	SQL_FreeHandle(g_SqlHandle)
}
		
public client_disconnect(id)	
{
	remove_task(id + MAX_PLAYERS * 2)
	
	ArpHudForget(id)
	
	if(g_GotInfo[id] >= STD_USER_QUERIES && !g_PluginEnd)
	{
		SaveUserData(id,1)
		g_GotInfo[id] = 0
	}
	
	g_SpeedOverride[id] = 0.0
	g_SpeedOverridePlugin[id] = 0
	
	TravTrieClear(g_SpeedTrie[id])
	
	//g_DisplayCharacterMenu[id] = 0
}

public SaveUserData(id,Disconnected)
{
	// H9: bots are never saved (client_putinserver), nor is a character that is not loaded: it has no key to save under
	if(is_user_bot(id) || !g_CharKey[id][0])
		return
	
	new Data[2]
	Data[0] = id
	Data[1] = Disconnected
	_CallEvent("Player_Save",Data,2)
	
	SaveUserItems(id)
	
	new Access[27],JobRight[27],JobName[33]
	ARP_IntToAccess(g_AccessCache[id],Access,26)
	ARP_IntToAccess(g_JobRight[id],JobRight,26)
	if(UTIL_ARP_ValidJobId(g_JobId[id]))   // H9: never the job array of a job that is not there
		array_get_string(array_get_int(g_JobsArray,g_JobId[id]),1,JobName,32)
	
	// H9: a job this map does not have is the one he came with (a map can have jobs of its own, item 18): it goes back
	// as it was, so a visit to another map does not cost him his rank
	if(g_KeptJob[id][0])
		copy(JobName,32,g_KeptJob[id])
	
	get_user_authid(id,g_Authid[id],35)
	if(containi(g_Authid[id],"PENDING") != -1 || containi(g_Authid[id],"LAN") != -1 || equali(g_Authid[id],"STEAM_0:0") || containi(g_Authid[id],"UNKNOWN") != -1)
		return
	
	ARP_SqlEscape(JobName,32)
	
	new Quoted[72]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),g_CharKey[id])
	
	format(g_Query,4095,"UPDATE %s SET bankmoney='%d',wallet='%d',jobname='%s',hunger='%d',access='%s',jobright='%s' WHERE authid='%s'",g_UserTable,g_BankMoney[id],g_Money[id],JobName,g_Hunger[id],Access,JobRight,Quoted)
	
	g_Saving[id] = 1
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"SaveUserDataHandle",g_Query,Data,2)
}

public SaveUserDataHandle(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	new id = Data[0],Authid[36]
	
	g_Saving[id] = 0
	
	if(g_PluginEnd)
		return PLUGIN_CONTINUE
	
	get_user_authid(id,Authid,35)
	
	if(!is_user_connected(id) || !equali(g_Authid[id],Authid) || Data[1])
		return ClearSettings(id)
	
	return PLUGIN_CONTINUE
}

ClearSettings(id)
{
	for(new Count,CurArray;Count < g_PropertyNum;Count++)
	{
		CurArray = array_get_int(g_PropertyArray,Count)
		H9_SetKey(CurArray,id,0)
	}
	
	g_UserItemNum[id] = 0
	
	g_Saving[id] = 0
	
	g_Access[id] = 0
	g_AccessCache[id] = 0
	
	g_Authid[id][0] = 0
	g_CharKey[id][0] = 0
	g_Acct[id] = 0
	
	g_BadJob[id] = 0
	g_KeptJob[id][0] = 0
	
	g_Display[id] = 1
	
	array_clear(g_UserItemArray[id])
	
	for(new Count;Count < HUD_NUM;Count++)
		//ClearHud(id,Count)
		TravTrieClear(g_HudArray[id][Count])
	
	return PLUGIN_CONTINUE
}

public CmdHelp(id)
{
	new Arg[33]
	read_argv(1,Arg,32)
	
	new Start = str_to_num(Arg),Items = get_pcvar_num(p_ItemsPerPage)
	
	if(Start >= g_CommandNum || Start < 0)
	{
		client_print(id,print_console,"No help items to display at this area.")
		return PLUGIN_HANDLED
	}
	
	new Data[2]
	Data[0] = id
	Data[1] = Start
	if(_CallEvent("Player_HelpMenu",Data,2))
		return PLUGIN_HANDLED
	
	client_print(id,print_console,"ARP Help List (Starting at #%d)",Start)
	client_print(id,print_console,"NUMBER   COMMAND   DESCRIPTION")
	
	for(new Count = Start;Count < Start + Items;Count++)
	{
		if(Count >= g_CommandNum)
			break
		
		array_get_string(array_get_int(g_CommandArray,Count + 1),1,Arg,32)
		array_get_string(array_get_int(g_CommandArray,Count + 1),2,g_Query,4095)
		
		client_print(id,print_console,"#%d   %s   %s",Count + 1,Arg,g_Query)
	}
	
	if(Start + Items < g_CommandNum)
		client_print(id,print_console,"Type ^"arp_help %d^" to view next items.",Start + Items)
	
	return PLUGIN_HANDLED
}

public CmdBuy(id)
{
	new Index,Body
	get_user_aiming(id,Index,Body,100)
	
	if(Index)
	{
		new Targetname[33],Return
		entity_get_string(Index,EV_SZ_targetname,Targetname,32)
		
		new Classname[33]
		entity_get_string(Index,EV_SZ_classname,Classname,32)
		
		new Property = UTIL_ARP_GetProperty(Targetname,Index)
		if(Property == -1)
			return PLUGIN_HANDLED
		
		//if((equal(Classname,"func_door") || equal(Classname,"func_door_rotating")) && entity_get_int(Index,EV_INT_bInDuck))
		//	ARP_RealProperty(Index,Targetname,Targetname,32)
		//else
		//	return PLUGIN_HANDLED
		
		new CurArray = array_get_int(g_PropertyArray,Property),Price = array_get_int(CurArray,4),Authid[36],EntAuthid[36]
		
		ArpKey(id,Authid,35)
		array_get_string(CurArray,3,EntAuthid,35)
		
		if(equali(Authid,EntAuthid))
		{
			client_print(id,print_chat,"[ARP] You already own this place.")
			return PLUGIN_HANDLED
		}
		
		if(Price && g_BankMoney[id] >= Price)
		{
			new Data[2]
			Data[0] = id
			Data[1] = Property + 1
			if(_CallEvent("Property_Buy",Data,2))
				return PLUGIN_HANDLED
			
			if(!Return)
			{
				new Players[MAX_PLAYERS],Playersnum,Player,PlayerAuthid[36],Flag
				get_players(Players,Playersnum)
				
				for(new Count;Count < Playersnum;Count++)
				{
					Player = Players[Count]
					
					ArpKey(Player,PlayerAuthid,35)
					
					if(equali(PlayerAuthid,EntAuthid))
					{
						g_BankMoney[Player] += Price
						
						new ExternalName[33],Name[33]
						get_user_name(id,Name,32)
						array_get_string(array_get_int(g_PropertyArray,Property),1,ExternalName,32)
						
						client_print(Player,print_chat,"[ARP] Your property, ^"%s^", has been bought by %s for $%d.",ExternalName,Name,Price)
						
						Flag = 1
						
						break
					}
				}
				
				if(!Flag)
				{
					new Quoted[72]
					SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),EntAuthid)
					
					format(g_Query,4095,"UPDATE %s SET bankmoney = bankmoney + %d WHERE authid='%s'",g_UserTable,Price,Quoted)
					UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
				}
				
				g_BankMoney[id] -= Price
				
				new Name[33]
				get_user_name(id,Name,32)
				
				array_set_string(CurArray,2,Name)
				array_set_string(CurArray,3,Authid)
				array_set_int(CurArray,4,0) 
				H9_ClearKeys(CurArray)
				array_set_int(CurArray,9,1)
				
				new InternalName[64]
				array_get_string(CurArray,0,InternalName,63)
				
				#if defined DEBUG
				g_TotalQueries++
				#endif
				
				ARP_SqlEscape(InternalName,63)
				
				format(g_Query,4095,"DELETE FROM %s WHERE authidkey LIKE '%%|%s'",g_KeysTable,InternalName)
				UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
			}
		}
		else
			client_print(id,print_chat,"[ARP] You do not have enough money in your bank account for this property.")
	}
		
	return PLUGIN_HANDLED
}

public CmdItems(id)
{
	g_MenuPage[id] = 0
	ShowItems(id)
	
	return PLUGIN_HANDLED
}

ShowItems(id)
{	
	if(!is_user_alive(id))
		return PLUGIN_HANDLED
	
	new Data[2]
	Data[0] = id
	if(_CallEvent("Item_Inventory",Data,1))
		return PLUGIN_HANDLED
	
	new Success,Num,ItemId,Size = array_size(g_UserItemArray[id])
	if(Size < 1)
	{
		client_print(id,print_chat,"[ARP] You have no items in your inventory.")
		return PLUGIN_HANDLED
	}
	
	new Menu = menu_create("ARP Items","ItemsHandle"),ItemName[33],Msg[128]
	
	while(Num < Size && (ItemId = array_get_nth(g_UserItemArray[id],++Num,_,Success)) != 0 && Success)
	{				
		//if(!array_isfilled(g_UserItemArray[id],ItemId))
		//	break
		
		Data[1] = ItemId
		if(_CallEvent("Item_AddItem",Data,2))
			return PLUGIN_HANDLED
		
		UTIL_ARP_ValidItemId(ItemId) ? UTIL_ARP_GetItemName(ItemId,ItemName,32) : copy(ItemName,32,"BAD ITEMID: Contact admin")
		format(Msg,127,"%s x %d",ItemName,UTIL_ARP_GetUserItemNum(id,ItemId))
		menu_additem(Menu,Msg,"")
		
		//if(ItemId == Last)
		//	break
	}
	
	arpvgui_menu_display(id,Menu,"arpcore.items","ARP Items","ItemsHandle")
	
	return PLUGIN_HANDLED
}	

public ItemsHandle(id,Menu,Item)
{
	menu_destroy(Menu)
	
	if(Item == MENU_EXIT) return
	
	new Success
	
	/*USER_ITEM_SCAN
		if(ItemNum++ >= Item)
		{
			ItemNum = Next
			break
		}*/
	
	new ItemId = array_get_nth(g_UserItemArray[id],Item + 1,_,Success),Data[2]
	Data[0] = id
	Data[1] = ItemId
	if(_CallEvent("Item_Menu",Data,2))
		return
	
	g_CurItem[id] = ItemId
	
	if(UTIL_ARP_GetUserItemNum(id,ItemId) <= 0)
		client_print(id,print_chat,"[ARP] You do not have any of this item.")
	else if(UTIL_ARP_ValidItemId(ItemId))
	{
		format(g_Query,4095,"ARP Item Options^n^n1. Use^n2. Give^n3. Examine^n4. Show^n5. Drop^n^n0. Exit")
		arpvgui_show_menu(id,g_Keys,g_Query,-1,g_ItemsOptions,"arpcore.itemopt")
	}
	else
		client_print(id,print_chat,"[ARP] This item is invalid. Please contact the administrator.")
		
	return
}

public ItemsOptions(id,Key)
	switch(Key)
	{
		case 0 :
			H9_UserUse(id,g_CurItem[id],0)
		
		case 1 :
		{
			format(g_Query,4095,"ARP Give Items^n^n1. Give 1^n2. Give 5^n3. Give 20^n4. Give 50^n5. Give 100^n6. Give All^n^n0. Exit")
			arpvgui_show_menu(id,g_Keys,g_Query,-1,g_ItemsGive,"arpcore.itemgive")
		}
		
		case 2 :
		{
			new ItemId = g_CurItem[id]
			if(!UTIL_ARP_ValidItemId(ItemId))
			{
				client_print(id,print_chat,"[ARP] This item is invalid. Please contact an administrator.")
				return
			}
			
			new Data[2]
			Data[0] = id
			Data[1] = ItemId
			
			if(_CallEvent("Item_Description",Data,2))
				return
				
			array_get_string(array_get_int(g_ItemsArray,ItemId),4,g_Query,63)
			
			client_print(id,print_chat,"[ARP] %s",g_Query)
		}
		
		case 3 :
		{
			new Index,Body
			get_user_aiming(id,Index,Body,100)
			
			if(!Index || !is_user_alive(Index))
				return
			
			H9_UserShow(id,Index,g_CurItem[id],0)
		}
		
		case 4 :
		{
			format(g_Query,4095,"ARP Drop Items^n^n1. Drop 1^n2. Drop 5^n3. Drop 20^n4. Drop 50^n5. Drop 100^n6. Drop All^n^n0. Exit")
			arpvgui_show_menu(id,g_Keys,g_Query,-1,g_ItemsDrop,"arpcore.itemdrop")
		}
	}

public ItemsGive(id,Key)
{
	new Index,Body,Num
	get_user_aiming(id,Index,Body,200)
	
	if(!Index || !is_user_alive(Index))
	{
		client_print(id,print_chat,"[ARP] You are not looking at a user.")
		return
	}
	
	new ItemId = g_CurItem[id]
	
	switch(Key)
	{
		case 0 :
			Num = 1
		case 1 :
			Num = 5
		case 2 :
			Num = 20
		case 3 :
			Num = 50
		case 4 :
			Num = 100
		case 5 :
			Num = abs(array_get_int(g_UserItemArray[id],g_CurItem[id]))
	}
	
	H9_UserGive(id,Index,ItemId,Num,0)
}	

public ItemsDrop(id,Key)
{
	if(Key == 9) return
	
	new Num,ItemNum = abs(array_get_int(g_UserItemArray[id],g_CurItem[id])),ItemId = g_CurItem[id]
	
	switch(Key)
	{
		case 0 :
			Num = 1
		case 1 :
			Num = 5
		case 2 :
			Num = 20
		case 3 :
			Num = 50
		case 4 :
			Num = 100
		case 5 :
			Num = ItemNum
	}
	
	H9_UserDrop(id,ItemId,Num,0)
}

// H9: the three actions of the item menu as functions. The text menu above and the inventory window (the natives ARP_UserUseItem, ARP_UserGiveItem
// and ARP_UserDropItem) run this same code, so an item event handler (Item_Use, Item_Give, Item_Drop), the g_ItemUse mutex and the item's own plugin
// behave the same for both. Each returns an ARP_ITEM_ code (include\ApolloRP_Items.inc); Quiet 1 leaves the refusals out of the chat, the window words them.
H9_UserUse(id,ItemId,Quiet)
{
	if(!UTIL_ARP_ValidItemId(ItemId) || !is_user_connected(id))
		return ARP_ITEM_INVALID

	if(UTIL_ARP_GetUserItemNum(id,ItemId) < 1)
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You do not have any of this item.")

		return ARP_ITEM_NONE
	}

	if(g_ItemUse[id])
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You are already using another item.")

		return ARP_ITEM_BUSY
	}

	new Data[2]
	Data[0] = id
	Data[1] = ItemId

	if(_CallEvent("Item_Use",Data,2))
		return ARP_ITEM_VETOED

	ItemUse(id,ItemId,1)

	return ARP_ITEM_OK
}

H9_UserGive(id,Index,ItemId,Num,Quiet)
{
	if(!UTIL_ARP_ValidItemId(ItemId) || Num < 1 || !is_user_connected(id) || Index == id || Index < 1 || Index > MAX_PLAYERS || !is_user_alive(Index))
		return ARP_ITEM_INVALID

	if(UTIL_ARP_GetUserItemNum(id,ItemId) < Num)
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You do not have enough of this item.")

		return ARP_ITEM_NONE
	}

	new Data[4]
	Data[0] = id
	Data[1] = Index
	Data[2] = ItemId
	Data[3] = Num

	if(_CallEvent("Item_Give",Data,4))
		return ARP_ITEM_VETOED

	new Names[2][33],ItemName[33]
	get_user_name(id,Names[0],32)
	get_user_name(Index,Names[1],32)

	// H9: all of it or none: the other player's inventory must have room for all of it (arp_h9_inv_slots)
	if(H9_InvRoom(Index,ItemId,Num) < Num)
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] %s's inventory is full.",Names[1])

		return ARP_ITEM_FULL
	}

	if(!UTIL_ARP_SetUserItemNum(Index,ItemId,UTIL_ARP_GetUserItemNum(Index,ItemId) + Num))
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] Sorry, that user cannot accept items right now.")

		return ARP_ITEM_VETOED
	}

	UTIL_ARP_SetUserItemNum(id,ItemId,UTIL_ARP_GetUserItemNum(id,ItemId) - Num)

	UTIL_ARP_GetItemName(ItemId,ItemName,32)

	client_print(id,print_chat,"[ARP] You have given %s %d %s%s.",Names[1],Num,ItemName,Num == 1 ? "" : "s")
	client_print(Index,print_chat,"[ARP] %s has given you %d %s%s.",Names[0],Num,ItemName,Num == 1 ? "" : "s")

	return ARP_ITEM_OK
}

H9_UserDrop(id,ItemId,Num,Quiet)
{
	if(!UTIL_ARP_ValidItemId(ItemId) || Num < 1 || !is_user_connected(id))
		return ARP_ITEM_INVALID

	if(UTIL_ARP_GetUserItemNum(id,ItemId) < Num)
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You do not have enough of this item.")

		return ARP_ITEM_NONE
	}

	new Data[3]
	Data[0] = id
	Data[1] = ItemId
	Data[2] = Num

	if(_CallEvent("Item_Drop",Data,3))
		return ARP_ITEM_VETOED

	// H9: the pack is made first and the items leave the player after it: nothing is destroyed without a pack on the floor
	if(!H9_MakePack(id,ItemId,Num))
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You cannot drop items right now.")

		return ARP_ITEM_NOPACK
	}

	UTIL_ARP_SetUserItemNum(id,ItemId,UTIL_ARP_GetUserItemNum(id,ItemId) - Num)

	return ARP_ITEM_OK
}

// H9: Show, the fourth action of the item menu: the item is shown to a player and nothing changes hands. The Item_Show event first (a plugin may give
// an item, a license or a card, its own readout and take the show), then the chat lines the item menu has always printed.
H9_UserShow(id,Index,ItemId,Quiet)
{
	if(!UTIL_ARP_ValidItemId(ItemId) || !is_user_connected(id) || Index == id || Index < 1 || Index > MAX_PLAYERS || !is_user_alive(Index))
		return ARP_ITEM_INVALID

	if(UTIL_ARP_GetUserItemNum(id,ItemId) < 1)
	{
		if(!Quiet)
			client_print(id,print_chat,"[ARP] You do not have any of this item.")

		return ARP_ITEM_NONE
	}

	new Data[3]
	Data[0] = id
	Data[1] = Index
	Data[2] = ItemId

	if(_CallEvent("Item_Show",Data,3))
		return ARP_ITEM_VETOED

	new Names[2][33],ItemName[33]
	get_user_name(id,Names[0],32)
	get_user_name(Index,Names[1],32)

	UTIL_ARP_GetItemName(ItemId,ItemName,32)

	client_print(id,print_chat,"[ARP] You show %s your %s.",Names[1],ItemName)
	client_print(Index,print_chat,"[ARP] %s shows you his %s.",Names[0],ItemName)

	return ARP_ITEM_OK
}

// H9: a pack of Num of an item on the floor at the player's feet (classname arp_item, which the use key picks up: what a drop makes, and the overflow of
// an add that does not fit); the entity, or 0 when none can be made (arp_performance 10 or less, or no entity left)
H9_MakePack(id,ItemId,Num)
{
	if(get_pcvar_num(p_Performance) <= 10 || Num < 1 || !UTIL_ARP_ValidItemId(ItemId))
		return 0

	new Name[33]
	UTIL_ARP_GetItemName(ItemId,Name,32)

	new Ent = create_entity("info_target"),Float:Origin[3]
	if(!Ent)
		return 0

	// Hawk552: Starting with v1.2, you can make premade items on your maps
	//	using this because it stores the info using names rather than ids
	entity_get_vector(id,EV_VEC_origin,Origin)
	entity_set_string(Ent,EV_SZ_classname,g_ItemClassname)
	entity_set_model(Ent,g_ItemModel)
	entity_set_origin(Ent,Origin)
	entity_set_string(Ent,EV_SZ_noise,Name)
	//entity_set_int(Ent,EV_INT_iuser1,ItemId)
	entity_set_int(Ent,EV_INT_iuser2,Num)
	entity_set_size(Ent,Float:{-2.5,-2.5,-2.5},Float:{2.5,2.5,2.5})

	entity_set_origin(id,Float:{0.0,0.0,0.0})
	drop_to_floor(Ent)
	entity_set_origin(id,Origin)

	H9_ItemIconMake(Ent,Name)
	H9_ItemGlowStart(Ent)

	return Ent
}

// H9: the use key on a pack on the floor: the player takes what his inventory has room for (arp_h9_inv_slots), and the rest stays in the pack
H9_PickUp(id,Ent)
{
	new Data[3],Quantity = entity_get_int(Ent,EV_INT_iuser2),ItemName[33]
	entity_get_string(Ent,EV_SZ_noise,ItemName,32)

	new ItemId = UTIL_ARP_FindItemId(ItemName)

	Data[0] = id
	Data[1] = ItemId
	Data[2] = Quantity

	if(_CallEvent("Item_Pickup",Data,3))
		return

	new Take = Quantity
	if(Quantity > 0 && UTIL_ARP_ValidItemId(ItemId))
		Take = H9_InvRoom(id,ItemId,Quantity)

	if(Take < Quantity)
	{
		new Text[128]

		if(Take < 1)
			copy(Text,127,"Your inventory is full.")
		else
		{
			UTIL_ARP_SetUserItemNum(id,ItemId,UTIL_ARP_GetUserItemNum(id,ItemId) + Take)
			entity_set_int(Ent,EV_INT_iuser2,Quantity - Take)

			UTIL_ARP_GetItemName(ItemId,ItemName,32)
			format(Text,127,"Your inventory is full: you took %d of %d %s.",Take,Quantity,ItemName)
		}

		H9_Note(id,1,Text)

		return
	}

	UTIL_ARP_SetUserItemNum(id,ItemId,UTIL_ARP_GetUserItemNum(id,ItemId) + Quantity)
	UTIL_ARP_GetItemName(ItemId,ItemName,32)

	client_print(id,print_chat,"[ARP] You have picked up %d %s%s.",Quantity,ItemName,Quantity == 1 ? "" : "s")

	H9_ItemIconOf(Ent)
	remove_entity(Ent)
}

public client_PostThink(id)
	if(is_user_alive(id) && !get_pcvar_num(p_FallDamage))
		entity_set_int(id,EV_INT_watertype,-3)
	
public client_PreThink(id)
{
	if(!is_user_alive(id))
		return
	
	if(g_SpeedOverridePlugin[id])
		set_user_maxspeed(id,g_SpeedOverride[id])
	else
	{
		new Float:NewSpeed = g_MaxSpeed[id],travTrieIter:Iter = GetTravTrieIterator(g_SpeedTrie[id]),Float:Mul,Flag
		while(MoreTravTrie(Iter))
		{
			ReadTravTrieCell(Iter,Mul)
			NewSpeed *= Mul
			
			Flag = 1
		}
		DestroyTravTrieIterator(Iter)
		
		if(Flag)
			set_user_maxspeed(id,NewSpeed)
	}
	
	g_Falling[id] = entity_get_float(id,EV_FL_flFallVelocity) > 350.0
	
	new Index,Body,EntList[50]
	get_user_aiming(id,Index,Body,100)
	new Aimed = Index
	
	static Classname[33],Data[3]
	
	if(entity_get_int(id,EV_INT_button) & IN_USE && !(entity_get_int(id,EV_INT_oldbuttons) & IN_USE))
	{
		if(Index && is_valid_ent(Index))
		{
			entity_get_string(Index,EV_SZ_classname,Classname,32)
			if(equali(Classname,"func_door") || equali(Classname,"func_door_rotating"))
			{
				// is really targetname now, but we should reuse variables
				entity_get_string(Index,EV_SZ_targetname,Classname,32)
				new Property = UTIL_ARP_GetProperty(Classname,Index)
				if(Property == -1)
					return
				
				new CurArray = array_get_int(g_PropertyArray,Property)
				
				static Authid[36],EntAuthid[36]
				ArpKey(id,Authid,35)
				array_get_string(CurArray,3,EntAuthid,35)
				
				if(!array_get_int(CurArray,5) || H9_HasKey(CurArray,id) || equali(Authid,EntAuthid) || array_get_int(CurArray,6) & g_Access[id])
				{
					Data[0] = id
					Data[1] = Index
					Data[2] = Property
					
					if(_CallEvent("Property_Use",Data,3))
						return
					
					client_print(id,print_chat,"[ARP] You used the door.")
					force_use(id,Index)
					fake_touch(Index,id)
				}
				else
					client_print(id,print_chat,"[ARP] This door is locked.")
				
				return
			}
		}
		
		if(find_sphere_class(id,g_ItemClassname,50.0,EntList,1))
		{
			H9_PickUp(id,EntList[0])
			
			return
		}
		
		if(Index && is_valid_ent(Index))
		{
			entity_get_string(Index,EV_SZ_classname,Classname,32)
			if(equal(Classname,g_NpcClassname))
			{
				new Plugin = entity_get_int(Index,EV_INT_iuser3),Handler[32]
				entity_get_string(Index,EV_SZ_noise,Handler,31)
				
				Data[0] = id
				Data[1] = Index
				
				if(_CallEvent("NPC_Use",Data,2))
					return
				
				NpcUse(Handler,Plugin,id,Index)
			}	
		}
		
		Index = 0
		while((Index = find_ent_by_class(Index,g_NpcZoneClassname)))
		{
			if(get_entity_distance(id,Index) > 100 || !fm_is_ent_visible(id,Index))
				continue
			
			new Plugin = entity_get_int(Index,EV_INT_iuser3),Handler[32]
			entity_get_string(Index,EV_SZ_noise,Handler,31)
			
			Data[0] = id
			Data[1] = Index
				
			if(_CallEvent("NPC_Use",Data,2))
				return
				
			NpcUse(Handler,Plugin,id,Index)
		}
		
		// H9: the use key on a player (the one aimed at, within 100 units): the event Player_Use (id, the player), which ARP_Inventory takes for an exchange of goods
		if(Aimed >= 1 && Aimed <= MAX_PLAYERS && is_user_alive(Aimed))
		{
			Data[0] = id
			Data[1] = Aimed
			
			_CallEvent("Player_Use",Data,2)
		}
	}	
	
	if(g_Display[id] && !is_user_bot(id))
		GetMsg(id,Index)
}

// H9: the dropped item the player looks toward, in view and within 120 units, or 0. An item's box is too small for the crosshair to hit it
// (get_user_aiming finds the floor behind it), so it is a cone of about 14 degrees from the eye; the one nearest the middle of it wins.
H9_AimedItem(id)
{
	new Float:Eye[3],Float:View[3],Float:Angles[3],Float:Forward[3]
	entity_get_vector(id,EV_VEC_origin,Eye)
	entity_get_vector(id,EV_VEC_view_ofs,View)
	Eye[0] += View[0]
	Eye[1] += View[1]
	Eye[2] += View[2]

	entity_get_vector(id,EV_VEC_v_angle,Angles)
	angle_vector(Angles,ANGLEVECTOR_FORWARD,Forward)

	new Ent,Best,Float:BestDot = 0.97,Float:Origin[3],Float:Length,Float:Dot
	while((Ent = find_ent_by_class(Ent,g_ItemClassname)))
	{
		entity_get_vector(Ent,EV_VEC_origin,Origin)
		Origin[0] -= Eye[0]
		Origin[1] -= Eye[1]
		Origin[2] -= Eye[2]

		Length = vector_length(Origin)
		if(Length < 1.0 || Length > 120.0)
			continue

		Dot = (Origin[0] * Forward[0] + Origin[1] * Forward[1] + Origin[2] * Forward[2]) / Length
		if(Dot > BestDot && fm_is_ent_visible(id,Ent))
		{
			BestDot = Dot
			Best = Ent
		}
	}

	return Best
}

// H9: the plaque. A line of it is added with its kind and a text that reads on its own; H9_PlaqueSend puts the lines in the notice HUD (HUD_QUAT), where the game
// draws them as a plaque panel (a game that does not know the kinds draws them as plain lines).
H9_PlaqueAdd(Kind,const Text[],{Float,Sql,Result,_}:...)
{
	if(g_PlaqueNum >= PLAQUE_LINES)
		return

	vformat(g_PlaqueText[g_PlaqueNum],HUDP_LINE_LEN - 1,Text,3)
	g_PlaqueKind[g_PlaqueNum++] = Kind
}

// the letters one of the three access cvars names (arp_police_access, arp_medical_access, arp_admin_access), as the bits ARP_AccessToInt makes
H9_AccessMask(const Cvar[])
{
	new Letters[JOB_ACCESSES + 1]
	get_cvar_string(Cvar,Letters,JOB_ACCESSES)

	return ARP_AccessToInt(Letters)
}

// What the plaque calls the affiliation of no letter: Proletarian while H9's team play runs (arp_teamplay with TS reporting the three teams: the Proletarians are the third
// team), the stock Civilian everywhere else. The client draws either as a plain outline (h9_arphud.cpp, KIND_PLQ_TAG).
H9_CivilianWord(Out[],Len)
{
	if(get_pcvar_num(p_H9Teamplay) != 0 && get_pcvar_num(p_H9TeamplayOn) != 0)
		copy(Out,Len,"Proletarian")
	else
		copy(Out,Len,"Civilian")
}

// The affiliation of a property's access letters: the police letter or the Lord Minister's g is the Ministry of Defense, the medical letter the Medical Division, both
// say both, a letter of arp_h9_insurgent_access the Insurgency, the admin letter alone Administration, anything else no affiliation (H9_CivilianWord).
H9_Affiliation(Access,Out[],Len)
{
	Out[0] = 0

	if(Access & (H9_AccessMask(g_PoliceAccessCvar) | H9_ACCESS_G))
		copy(Out,Len,"Ministry of Defense")

	if(Access & H9_AccessMask(g_MedicalAccessCvar))
	{
		if(Out[0])
			add(Out,Len," / ")
		add(Out,Len,"Medical Division")
	}

	if(!Out[0] && (Access & H9_AccessMask(g_H9InsurgentAccessCvar)))
		copy(Out,Len,"Insurgency")

	if(!Out[0] && (Access & H9_AccessMask(g_AdminAccessCvar)))
		copy(Out,Len,"Administration")

	if(!Out[0])
		H9_CivilianWord(Out,Len)
}

// The team that the access letters of a job put a player on, the one rule of team play (include\ApolloRP_H9Teams.inc): the police letter, the medical letter or the Lord
// Minister's g make him the Middle Sea Republic's, a letter of arp_h9_insurgent_access the Insurrection's, anything else the Proletarians'. The Republic is asked first, so a job
// that holds letters of both is the Republic's. The affiliation line of the plaque asks it as well.
H9_TeamOfAccess(Access)
{
	if(Access & (H9_AccessMask(g_PoliceAccessCvar) | H9_AccessMask(g_MedicalAccessCvar) | H9_ACCESS_G))
		return ARP_H9_TEAM_MSR
	
	if(Access & H9_AccessMask(g_H9InsurgentAccessCvar))
		return ARP_H9_TEAM_INSURRECTION
	
	return ARP_H9_TEAM_PROLETARIAN
}

// H9: team play runs on this map: arp_teamplay is 1 and ARP_TS has found TS reporting the three teams (arp_teamplay_on)
bool:H9_TeamsLive()
	return get_pcvar_num(p_H9Teamplay) != 0 && get_pcvar_num(p_H9TeamplayOn) != 0

// The team of a player, what ARP_H9_TeamOf answers: 0 while team play does not run; the team of the letters of his job (H9_TeamOfAccess); for a bot, which has no job, the
// team field of its entity, which the plugin that runs it sets. This is the one place that says where the answer comes from.
H9_PlayerTeam(id)
{
	if(!H9_TeamsLive() || id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
		return ARP_H9_TEAM_NONE
	
	if(is_user_bot(id))
	{
		new Team = entity_get_int(id,EV_INT_team)
		return (Team >= ARP_H9_TEAM_FIRST && Team <= ARP_H9_TEAMS) ? Team : ARP_H9_TEAM_NONE
	}
	
	return H9_TeamOfAccess(g_Access[id])
}

// What the plaque calls a team: the Republic's is the Middle Sea Republic, the Insurrection's the Insurgency (the scoreboard calls the team Insurrection) and the Proletarians'
// Proletarian while team play runs, else Civilian (H9_CivilianWord; the scoreboard calls the team Proletarians). These are the plaque's own words, not the teams' names (g_H9TeamNames).
H9_TeamAffiliation(Team,Out[],Len)
{
	switch(Team)
	{
		case ARP_H9_TEAM_MSR:
			copy(Out,Len,"Middle Sea Republic")
		case ARP_H9_TEAM_INSURRECTION:
			copy(Out,Len,"Insurgency")
		default:
			H9_CivilianWord(Out,Len)
	}
}

// The affiliation of a player, from the access letters of his job: the team they put him on says it (H9_TeamOfAccess), the admin letter alone Administration.
H9_PlayerAffiliation(Access,Out[],Len)
{
	new Team = H9_TeamOfAccess(Access)
	
	if(Team == ARP_H9_TEAM_PROLETARIAN && (Access & H9_AccessMask(g_AdminAccessCvar)))
		copy(Out,Len,"Administration")
	else
		H9_TeamAffiliation(Team,Out,Len)
}

// The affiliation of the player another one looks at: the letters of his job say it; a bot has no job, so while team play runs its team field does (a citizen is of the
// Proletarians, which the plaque calls Proletarian, an insurgent of tsrp_roambots of the Insurrection, which it calls Insurgency).
H9_AffiliationOfPlayer(Index,Out[],Len)
{
	if(is_user_bot(Index) && H9_TeamsLive())
		H9_TeamAffiliation(H9_PlayerTeam(Index),Out,Len)
	else
		H9_PlayerAffiliation(g_Access[Index],Out,Len)
}

// Who a locked property asks for, for the Restricted line: its access letters in words, "keyholders" for a property that names none.
H9_AccessWho(Access,Out[],Len)
{
	Out[0] = 0

	if(Access & H9_AccessMask(g_PoliceAccessCvar))
		copy(Out,Len,"Ministry of Defense")

	if(Access & H9_AccessMask(g_MedicalAccessCvar))
	{
		if(Out[0])
			add(Out,Len," / ")
		add(Out,Len,"Medical Division")
	}

	if(Access & H9_AccessMask(g_H9InsurgentAccessCvar))
	{
		if(Out[0])
			add(Out,Len," / ")
		add(Out,Len,"Insurgency")
	}

	if(!Out[0] && (Access & H9_ACCESS_G))
		copy(Out,Len,"the Lord Minister")

	if(!Out[0] && Access)
		copy(Out,Len,"authorised personnel")

	if(!Out[0])
		copy(Out,Len,"keyholders")
}

// The job of a property's owner, when he is in the game and has one that is not Unemployed; Rank is empty otherwise.
H9_OwnerRank(const OwnerAuth[],Rank[],Len)
{
	Rank[0] = 0
	if(!OwnerAuth[0])
		return

	new Players[MAX_PLAYERS],Playersnum,Player,Key[36]
	get_players(Players,Playersnum)

	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]

		ArpKey(Player,Key,35)
		if(!equali(Key,OwnerAuth))
			continue

		if(UTIL_ARP_ValidJobId(g_JobId[Player]))
			array_get_string(array_get_int(g_JobsArray,g_JobId[Player]),1,Rank,Len)

		if(equali(Rank,"Unemployed"))
			Rank[0] = 0

		return
	}
}

// The owner and the affiliation of a property, as plaque lines: Owner: <name> (<job>), "For sale: $N" for an owner who has put it up, Owner: For sale, $N for none, or
// Owner: State property for none and no price; then Affiliation: from its access letters.
H9_PlaqueOwner(CurArray)
{
	static OwnerName[40],OwnerAuth[36],Rank[33],Affil[96]
	array_get_string(CurArray,2,OwnerName,39)
	array_get_string(CurArray,3,OwnerAuth,35)
	new Price = array_get_int(CurArray,4)

	if(OwnerName[0])
	{
		H9_OwnerRank(OwnerAuth,Rank,32)

		if(Rank[0])
			H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Owner: %s (%s)",OwnerName,Rank)
		else
			H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Owner: %s",OwnerName)

		if(Price)
			H9_PlaqueAdd(HUDK_PLAQUE_ROW,"For sale: $%d",Price)
	}
	else if(Price)
		H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Owner: For sale, $%d",Price)
	else
		H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Owner: State property")

	H9_Affiliation(array_get_int(CurArray,6),Affil,95)
	H9_PlaqueAdd(HUDK_PLAQUE_TAG,"Affiliation: %s",Affil)
}

// A property door: the establishment, owner, affiliation, status, and the Restricted line when the property is locked and the viewer has neither a key, the property
// nor the access letters (the test the use key makes, client_PreThink), and the buy hint when it has a price.
H9_PlaqueDoor(id,Property)
{
	static Name[64],OwnerAuth[36],Key[36],Who[96]
	new CurArray = array_get_int(g_PropertyArray,Property)
	array_get_string(CurArray,1,Name,63)
	array_get_string(CurArray,3,OwnerAuth,35)
	new Price = array_get_int(CurArray,4),Locked = array_get_int(CurArray,5),Access = array_get_int(CurArray,6)

	g_PlaqueNum = 0
	if(Name[0])
		H9_PlaqueAdd(HUDK_PLAQUE,"%s",Name)
	else
		H9_PlaqueAdd(HUDK_PLAQUE,"Property")

	H9_PlaqueOwner(CurArray)

	if(Locked)
		H9_PlaqueAdd(HUDK_PLAQUE_SEALED,"Status: Locked")
	else
		H9_PlaqueAdd(HUDK_PLAQUE_OPEN,"Status: Unlocked")

	if(Locked)
	{
		ArpKey(id,Key,35)
		if(!H9_HasKey(CurArray,id) && !equali(Key,OwnerAuth) && !(Access & g_Access[id]))
		{
			H9_AccessWho(Access,Who,95)
			H9_PlaqueAdd(HUDK_PLAQUE_WARN,"Restricted: %s only",Who)
		}
	}

	if(Price)
		H9_PlaqueAdd(HUDK_PLAQUE_HINT,"Say /buy to purchase")
}

// An NPC: its name, its role from the handler its plugin gave it (ARP_NPCs: shop, bank, doctor, gun shop, ATM), and how to use it. The property its npcs.ini block names
// takes the profit of its sales (ARP_GetNpcProperty) and is not on the plaque: an NPC has no owner.
H9_PlaqueNpc(Index)
{
	static Name[33],Handler[32],Role[16]
	entity_get_string(Index,EV_SZ_noise1,Name,32)
	entity_get_string(Index,EV_SZ_noise,Handler,31)

	Role[0] = 0
	if(equal(Handler,"EdekaHandle"))
		copy(Role,15,"Shop")
	else if(equal(Handler,"BankHandle"))
		copy(Role,15,"Bank")
	else if(equal(Handler,"DoctorHandle"))
		copy(Role,15,"Doctor")
	else if(equal(Handler,"GunshopHandle"))
		copy(Role,15,"Gun shop")
	else if(equal(Handler,"AtmHandle"))
		copy(Role,15,"ATM")

	g_PlaqueNum = 0
	H9_PlaqueAdd(HUDK_PLAQUE,"%s",Name)

	if(Role[0])
		H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Role: %s",Role)

	H9_PlaqueAdd(HUDK_PLAQUE_HINT,"Press use (default e) to use")
}

// A player: his name, his job (the rank) when he has one, and the affiliation of his job's access letters.
H9_PlaquePlayer(Index)
{
	static Name[33],JobName[33],Affil[96]
	get_user_name(Index,Name,32)

	JobName[0] = 0
	if(UTIL_ARP_ValidJobId(g_JobId[Index]))
		array_get_string(array_get_int(g_JobsArray,g_JobId[Index]),1,JobName,32)

	g_PlaqueNum = 0
	H9_PlaqueAdd(HUDK_PLAQUE,"%s",Name)

	if(JobName[0])
		H9_PlaqueAdd(HUDK_PLAQUE_ROW,"Job: %s",JobName)

	H9_AffiliationOfPlayer(Index,Affil,95)
	H9_PlaqueAdd(HUDK_PLAQUE_TAG,"Affiliation: %s",Affil)
}

// The plaque as the notice HUD of a game that draws the HUD as panels, in place of the one text line (the last line renders the HUD)
H9_PlaqueSend(id)
{
	TravTrieClear(TravTrie:g_HudArray[id][HUD_QUAT])

	for(new Count;Count < g_PlaqueNum;Count++)
		UTIL_ARP_AddHudItem(id,HUD_QUAT,g_PlaqueText[Count],(Count == g_PlaqueNum - 1 && !g_HudPending) ? 1 : 0,g_PlaqueKind[Count])
}

// H9: whether an entity is a pack of items on the floor (what a drop makes)
bool:H9_IsItemPack(Ent)
{
	static Classname[33]
	entity_get_string(Ent,EV_SZ_classname,Classname,32)

	return equal(Classname,g_ItemClassname) ? true : false
}

// H9: reads the list of the picture sheet and precaches the sheet, unless arp.cfg says arp_h9_itemicon 0 (read from the file: the server executes arp.cfg after the precache, so a change
// to 1 needs a map change). A name whose frame is not one of the sheet's (its header's number of frames) is left out, and an item that is not in the list has no icon.
H9_ItemIconPrecache()
{
	g_ItemIconIdx = 0

	if(!h9_cfg_num("arp_h9_itemicon",1))
		return

	if(!file_exists(g_ItemIconSheet) || !file_exists(g_ItemIconList))
	{
		log_amx("[ARP] arp_h9_itemicon is 1 but %s or %s is not on this server: no picture stands over a dropped item.",g_ItemIconSheet,g_ItemIconList)
		return
	}

	new Sheet = fopen(g_ItemIconSheet,"rb"),Frames
	if(!Sheet)
		return

	fseek(Sheet,28,SEEK_SET)
	fread(Sheet,Frames,BLOCK_INT)
	fclose(Sheet)

	if(Frames < 1)
		return

	new File = fopen(g_ItemIconList,"rt")
	if(!File)
		return

	g_ItemIconFrames = TrieCreate()

	new Line[96],Name[40],Bar,Frame
	while(!feof(File))
	{
		Line[0] = 0
		fgets(File,Line,95)
		trim(Line)

		Bar = contain(Line,"|")
		if(Bar < 1 || Line[0] == '#' || Line[0] == '/')
			continue

		copy(Name,min(Bar,39),Line)
		strtolower(Name)

		Frame = str_to_num(Line[Bar + 1])
		if(Frame >= 0 && Frame < Frames)
			TrieSetCell(g_ItemIconFrames,Name,Frame)
	}
	fclose(File)

	if(TrieGetSize(g_ItemIconFrames))
		g_ItemIconIdx = precache_model(g_ItemIconSheet)
	else
		log_amx("[ARP] %s names no frame of %s: no picture stands over a dropped item.",g_ItemIconList,g_ItemIconSheet)
}

// H9: the oldest icon that stands, and in Count how many do
H9_ItemIconOldest(&Count)
{
	new Icon,Oldest,OldestSerial = cellmax
	Count = 0

	while((Icon = find_ent_by_class(Icon,g_ItemIconClassname)))
	{
		Count++

		if(entity_get_int(Icon,EV_INT_iuser2) < OldestSerial)
		{
			OldestSerial = entity_get_int(Icon,EV_INT_iuser2)
			Oldest = Icon
		}
	}

	return Oldest
}

// H9: takes an icon down. Pack, when it is not 0, is the pack the icon must belong to: an entity number the server has given to something else since is left alone.
H9_ItemIconRemove(Icon,Pack)
{
	if(Icon < 1 || !is_valid_ent(Icon))
		return

	static Classname[16]
	entity_get_string(Icon,EV_SZ_classname,Classname,15)
	if(!equal(Classname,g_ItemIconClassname))
		return

	new Owner = entity_get_int(Icon,EV_INT_iuser1)
	if(Pack && Owner != Pack)
		return

	if(Owner > 0 && is_valid_ent(Owner) && H9_IsItemPack(Owner) && entity_get_int(Owner,EV_INT_iuser3) == Icon)
		entity_set_int(Owner,EV_INT_iuser3,0)

	remove_entity(Icon)
}

// H9: the pack is going: its icon goes with it
H9_ItemIconOf(Pack)
{
	new Icon = entity_get_int(Pack,EV_INT_iuser3)
	if(Icon)
		H9_ItemIconRemove(Icon,Pack)
}

// H9: the picture of an item over its pack: the icon's entity, or 0 when there is none (arp_h9_itemicon is 0, the sheet or its list is not there, the item has no picture in the list,
// arp_h9_itemicon_max is 0, the entity table has no room to spare). With arp_h9_itemicon_max icons standing, the oldest makes way, so the packs dropped last keep theirs.
H9_ItemIconMake(Pack,const ItemName[])
{
	if(!g_ItemIconIdx || !get_pcvar_num(p_H9ItemIcon))
		return 0

	static Key[33]
	copy(Key,32,ItemName)
	strtolower(Key)

	new Frame
	if(!TrieGetCell(g_ItemIconFrames,Key,Frame))
		return 0

	new Max = clamp(get_pcvar_num(p_H9ItemIconMax),0,H9_ITEMICON_MAX)
	if(Max < 1)
		return 0

	new Count,Oldest = H9_ItemIconOldest(Count)
	if(Count >= Max)
		H9_ItemIconRemove(Oldest,0)

	// the engine stops the server when it has no edict left, and create_entity cannot say so: an icon is made only while the table has room to spare
	if(entity_count() + H9_ITEMICON_SPARE >= get_global_int(GL_maxEntities))
		return 0

	new Ent = create_entity("info_target")
	if(!Ent)
		return 0

	new Float:Scale = get_pcvar_float(p_H9ItemIconScale)
	if(Scale < 0.2)
		Scale = 0.2
	else if(Scale > 4.0)
		Scale = 4.0

	// the middle of the picture: the height of a backpack, half the picture and a little air over the pack
	new Float:Origin[3]
	entity_get_vector(Pack,EV_VEC_origin,Origin)
	Origin[2] += 16.0 + 16.0 * Scale + 4.0

	entity_set_string(Ent,EV_SZ_classname,g_ItemIconClassname)
	entity_set_model(Ent,g_ItemIconSheet)
	entity_set_origin(Ent,Origin)
	entity_set_int(Ent,EV_INT_movetype,MOVETYPE_NONE)
	entity_set_int(Ent,EV_INT_solid,SOLID_NOT)
	entity_set_int(Ent,EV_INT_rendermode,kRenderNormal)
	entity_set_int(Ent,EV_INT_renderfx,kRenderFxNoDissipation)
	entity_set_float(Ent,EV_FL_renderamt,0.0)
	entity_set_float(Ent,EV_FL_scale,Scale)
	entity_set_float(Ent,EV_FL_frame,float(Frame))
	entity_set_int(Ent,EV_INT_iuser1,Pack)
	entity_set_int(Ent,EV_INT_iuser2,++g_ItemIconSerial)
	entity_set_int(Pack,EV_INT_iuser3,Ent)

	return Ent
}

// H9: every few seconds an icon whose pack is gone, is another or does not name it back is taken down (the pack was removed by something that knows nothing of icons), the icons that
// stand are no more than arp_h9_itemicon_max, and with arp_h9_itemicon 0 none stand
public H9_ItemIconSweep()
{
	new Icon,Pack,bool:On = get_pcvar_num(p_H9ItemIcon) ? true : false

	while((Icon = find_ent_by_class(Icon,g_ItemIconClassname)))
	{
		Pack = entity_get_int(Icon,EV_INT_iuser1)

		if(!On || Pack < 1 || !is_valid_ent(Pack) || !H9_IsItemPack(Pack) || entity_get_int(Pack,EV_INT_iuser3) != Icon)
			H9_ItemIconRemove(Icon,0)
	}

	new Count,Oldest = H9_ItemIconOldest(Count),Max = clamp(get_pcvar_num(p_H9ItemIconMax),0,H9_ITEMICON_MAX)
	for(new Guard;Count > Max && Oldest && Guard < H9_ITEMICON_MAX;Guard++)
	{
		H9_ItemIconRemove(Oldest,0)
		Oldest = H9_ItemIconOldest(Count)
	}
}

// H9: the settings of the glow: the colour in Rgb (arp_h9_itemglow_color; the purple when it does not read as three numbers or is all 0), the reach of the light in units (40 to 600) and the
// seconds a pack glows for (0 to 600)
H9_ItemGlowRead(Rgb[3],&Radius,&Seconds)
{
	static Shade[32],Red[8],Green[8],Blue[8]
	get_pcvar_string(p_H9ItemGlowColor,Shade,31)

	new Parsed = parse(Shade,Red,7,Green,7,Blue,7)

	Rgb[0] = clamp(str_to_num(Red),0,255)
	Rgb[1] = clamp(str_to_num(Green),0,255)
	Rgb[2] = clamp(str_to_num(Blue),0,255)

	// fewer than three numbers (the strings are static, so the ones a colour lacks hold what an earlier call left) or a colour of no light at all is the purple
	if(Parsed < 3 || (!Rgb[0] && !Rgb[1] && !Rgb[2]))
	{
		Rgb[0] = 180
		Rgb[1] = 60
		Rgb[2] = 255
	}

	Radius = clamp(get_pcvar_num(p_H9ItemGlowRadius),40,600)
	Seconds = clamp(get_pcvar_num(p_H9ItemGlowTime),0,600)
}

// H9: one pulse of the glow over a pack: a point light a little over it, in the open air, that fades out by itself in 1.2 seconds (its radius falls to nothing as its life ends). Left is the
// seconds the pack has yet to glow: over the last three the light shrinks, so that the glow dies away and does not stop. The message goes to whoever can see the point (MSG_PVS) and to nobody else.
H9_ItemGlowPulse(Pack,Float:Left,Radius,const Rgb[3])
{
	new Float:Pos[3],Origin[3]
	entity_get_vector(Pack,EV_VEC_origin,Pos)

	Origin[0] = floatround(Pos[0])
	Origin[1] = floatround(Pos[1])
	Origin[2] = floatround(Pos[2]) + 12

	if(Left < 3.0)
		Radius = floatround(float(Radius) * Left / 3.0)

	new Tens = clamp(Radius / 10,2,60)

	message_begin(MSG_PVS,SVC_TEMPENTITY,Origin)
	write_byte(TE_DLIGHT)
	write_coord(Origin[0])
	write_coord(Origin[1])
	write_coord(Origin[2])
	write_byte(Tens)	// the radius, in tens of units
	write_byte(Rgb[0])
	write_byte(Rgb[1])
	write_byte(Rgb[2])
	write_byte(12)	// the life, in tenths of a second
	write_byte(Tens * 10 / 12)	// the decay, in tens of units a second: the radius is gone when the life is
	message_end()
}

// H9: a pack that has just been made glows for arp_h9_itemglow_time seconds, beginning with a pulse now; the game's time it glows until is kept in its fuser1. The beat that sends the pulses after
// this one starts here if it is not running
H9_ItemGlowStart(Pack)
{
	if(!get_pcvar_num(p_H9ItemGlow))
		return

	new Rgb[3],Radius,Seconds
	H9_ItemGlowRead(Rgb,Radius,Seconds)

	if(Seconds < 1)
		return

	entity_set_float(Pack,EV_FL_fuser1,get_gametime() + float(Seconds))
	H9_ItemGlowPulse(Pack,float(Seconds),Radius,Rgb)

	if(!task_exists(H9_ITEMGLOW_TASK))
		set_task(H9_ITEMGLOW_BEAT,"H9_ItemGlowBeat",H9_ITEMGLOW_TASK,"",0,"b")
}

// H9: every beat each pack that has glow time left is sent a pulse (at most H9_ITEMGLOW_MAX of them), and when none has any left the beat stops, until the next drop starts it again. With
// arp_h9_itemglow 0 no pulse is sent and the beat stops at its next turn.
public H9_ItemGlowBeat()
{
	new Float:Now = get_gametime(),Float:Until,Lit,Ent

	if(get_pcvar_num(p_H9ItemGlow))
	{
		new Rgb[3],Radius,Seconds
		H9_ItemGlowRead(Rgb,Radius,Seconds)

		while((Ent = find_ent_by_class(Ent,g_ItemClassname)))
		{
			Until = entity_get_float(Ent,EV_FL_fuser1)
			if(Until <= Now)
				continue

			if(++Lit <= H9_ITEMGLOW_MAX)
				H9_ItemGlowPulse(Ent,Until - Now,Radius,Rgb)
		}
	}

	if(!Lit)
		remove_task(H9_ITEMGLOW_TASK)
}

// H9: a dropped item says what it is and how many to the player who looks toward it from within 120 units (tried four times a second; arp_h9_itemhover 0 leaves
// it out). GetMsg calls it when nothing else is aimed at.
H9_ItemLook(id)
{
	if(!get_pcvar_num(p_H9ItemHover) || get_gametime() < g_H9ItemScan[id])
		return

	g_H9ItemScan[id] = get_gametime() + 0.25

	new Item = H9_AimedItem(id)
	if(!Item)
		return

	static Message[128],ItemName[33]
	entity_get_string(Item,EV_SZ_noise,ItemName,32)
	new Quantity = entity_get_int(Item,EV_INT_iuser2)

	if(Quantity > 1)
		format(Message,127,"%s x%d",ItemName,Quantity)
	else
		copy(Message,127,ItemName)

	if(get_entity_distance(id,Item) <= 50)
		add(Message,127,"^nPress use (default e) to pick up")

	// H9: a game that draws the HUD as a panel and says _h9vgui 7 is sent the item's picture as well, a line of kind HUDK_ICON that the panel
	// draws above the notice (docs\ARP_INVENTORY_WINDOW.txt, 4); every other game gets the text alone
	if(get_pcvar_num(p_AuxType) == 2 && g_HudPanel[id] && h9vgui_protocol(id) >= H9VGUI_CREDIT_PROTOCOL)
	{
		static Icon[40]
		formatex(Icon,39,"icon:%s",ItemName)
		TravTrieClear(TravTrie:g_HudArray[id][HUD_QUAT])
		UTIL_ARP_AddHudItem(id,HUD_QUAT,Icon,0,HUDK_ICON)
		UTIL_ARP_AddHudItem(id,HUD_QUAT,Message,!g_HudPending,HUDK_EXTRA)
	}
	else
		UTIL_ARP_ClientPrint(id,"%s",Message)
}

GetMsg(id,Index)
{
	// H9: nothing is aimed at (the world: a pack on the floor is too small for the crosshair) or the crosshair is on the pack itself: a dropped item the player
	// looks toward names itself, and a plaque that was held for a door is forgotten
	if(!Index || (is_valid_ent(Index) && H9_IsItemPack(Index)))
	{
		g_PlaqueKey[id] = 0
		H9_ItemLook(id)
		return
	}

	if(!is_valid_ent(Index))
		return
	
	//if(g_HudPending)
	//	client_print(id,print_chat,"Hud Pending")
	
	static Name[33],Message[128],Classname[33]
	entity_get_string(Index,EV_SZ_classname,Classname,32)
	
	new Ent
	while((Ent = find_ent_by_class(Ent,g_NpcZoneClassname)))
	{
		if(!get_entity_distance(id,Ent) || !fm_is_ent_visible(id,Ent))
			continue
		
		entity_get_string(Ent,EV_SZ_noise1,Name,32)
		
		format(Message,127,"%s^nPress use (default e) to use",Name)
		
		UTIL_ARP_ClientPrint(id,"%s",Message)
		
		break
	}
	

	entity_get_string(Index,EV_SZ_classname,Classname,32)

	// H9: the plaque (arp_h9_plaque). A game that draws the HUD as panels (arp_hud4_type 2) is sent it as the lines of the notice HUD; every other game gets the text it
	// always had, with an Affiliation line. A panel player who keeps looking at the same thing is left alone for PLAQUE_REBUILD seconds: his game holds what it was
	// sent, and the core sends the same lines again only every HUDP_NOTICE_GAP seconds.
	new bool:Plaque = get_pcvar_num(p_H9Plaque) != 0
	new bool:Panel = Plaque && get_pcvar_num(p_AuxType) == 2 && g_HudPanel[id]

	if(Panel && g_PlaqueKey[id] == Index && get_gametime() < g_PlaqueAt[id] + PLAQUE_REBUILD)
		return

	g_PlaqueKey[id] = 0

	if(equal(Classname,g_NpcClassname))
	{
		if(Panel)
		{
			H9_PlaqueNpc(Index)
			H9_PlaqueSend(id)

			g_PlaqueKey[id] = Index
			g_PlaqueAt[id] = get_gametime()
		}
		else
		{
			entity_get_string(Index,EV_SZ_noise1,Name,32)

			format(Message,127,"%s^nPress use (default e) to use",Name)

			UTIL_ARP_ClientPrint(id,"%s",Message)
		}
	}
	else if(equali(Classname,"func_door") || equali(Classname,"func_door_rotating"))
	{
		static CurTargetname[33]
		entity_get_string(Index,EV_SZ_targetname,CurTargetname,32)

		new Property = UTIL_ARP_GetProperty(CurTargetname,Index)
		if(Property == -1)
		{
			// a door of no property says nothing; a panel player is not looked up again for a moment
			if(Panel)
			{
				g_PlaqueKey[id] = Index
				g_PlaqueAt[id] = get_gametime()
			}

			return
		}

		if(Panel)
		{
			H9_PlaqueDoor(id,Property)
			H9_PlaqueSend(id)

			g_PlaqueKey[id] = Index
			g_PlaqueAt[id] = get_gametime()
		}
		else
		{
			static Ownername[33],Purchase[64],Affil[96],AffilLine[112]

			new CurArray = array_get_int(g_PropertyArray,Property)
			array_get_string(CurArray,1,Name,32)
			array_get_string(CurArray,2,Ownername,32)
			new Price = array_get_int(CurArray,4)

			format(Message,127,"^nOwner: %s",Ownername)
			format(Purchase,63,"^nPrice: $%d. Say /buy to purchase.",Price)

			AffilLine[0] = 0
			if(Plaque)
			{
				H9_Affiliation(array_get_int(CurArray,6),Affil,95)
				formatex(AffilLine,111,"^nAffiliation: %s",Affil)
			}

			UTIL_ARP_ClientPrint(id,"%s%s%s%s^nStatus: %s",Name[0] ? Name : "",Ownername[0] ? Message : "", Price ? Purchase : "",AffilLine,array_get_int(CurArray,5) ? "Locked" : "Unlocked")
		}
	}
	else if(get_pcvar_num(p_HoverMessage) && equali(Classname,"player"))
	{
		if(Panel)
		{
			// a player who is not alive (his body is not the player's edict, but a spectator may be aimed at) is not described
			if(is_user_alive(Index))
			{
				H9_PlaquePlayer(Index)
				H9_PlaqueSend(id)
			}

			g_PlaqueKey[id] = Index
			g_PlaqueAt[id] = get_gametime()
		}
		else
		{
			static JobName[33],Name[33],Affil[96],AffilLine[112]
			get_user_name(Index,Name,32)
			JobName[0] = 0
			if(UTIL_ARP_ValidJobId(g_JobId[Index]))   // H9: never the job array of a job that is not there
				array_get_string(array_get_int(g_JobsArray,g_JobId[Index]),1,JobName,32)

			AffilLine[0] = 0
			if(Plaque)
			{
				H9_AffiliationOfPlayer(Index,Affil,95)
				formatex(AffilLine,111,"^nAffiliation: %s",Affil)
			}

			UTIL_ARP_ClientPrint(id,"Name: %s^nJob: %s%s",Name,JobName,AffilLine)

			//if(g_HudPending)
			//	client_print(id,print_chat,"Hud Added")
		}
	}
	// H9: the crosshair is on something none of the branches above names (a prop; a player, while arp_hover_message is 0): the dropped item toward which he looks says what it is (the
	// crosshair on the world or on the pack itself is dealt with at the top of this function; a door of no property and an NPC return or print above)
	else
		H9_ItemLook(id)

	if(!g_HudPending)
	{
		g_Display[id] = 0
		set_task(0.1,"ResetDisplay",id)
	}
}

public ResetDisplay(id)
	g_Display[id] = 1

NpcUse(Handler[],Plugin,id,Index)
{
	new Forward = CreateOneForward(Plugin,Handler,FP_CELL,FP_CELL),Return
	// duplicate code, but whatever
	if(Forward < 0)
	{
		format(g_Query,4095,"Function does not exist: %s",Handler)
		return UTIL_ARP_ThrowError(0,0,g_Query,Plugin)
	}
	
	if(!ExecuteForward(Forward,Return,id,Index))
	{
		format(g_Query,4095,"Function does not exist: %s",Handler)
		return UTIL_ARP_ThrowError(0,0,g_Query,Plugin)
	}
	
	DestroyForward(Forward)
	
	return SUCCEEDED
}

public plugin_natives()
{
	register_library("arp")
	
	set_module_filter("ModuleFilter")
	set_native_filter("NativeFilter")
	
	register_native("ARP_Version","_ARP_Version")
	
	register_native("ARP_Log","_ARP_Log")
	
	register_native("ARP_RegisterAddon","_ARP_RegisterAddon")
	register_native("ARP_AddonTrie","_ARP_AddonTrie")
	register_native("ARP_AddonLoaded","_ARP_AddonLoaded")
	
	register_native("ARP_FileOpen","_ARP_FileOpen")
	
	register_native("ARP_SqlMode","_ARP_SqlMode")
	register_native("ARP_SqlHandle","_ARP_SqlHandle")
	register_native("ARP_GetTable","_ARP_GetTable")
	register_native("ARP_CleverQueryBackend","_ARP_CleverQueryBackend")
	
	register_native("ARP_GetConfigsdir","_ARP_GetConfigsdir")
	
	register_native("ARP_GetNpcClassname","_ARP_GetNpcClassname")
	register_native("ARP_RegisterNpc","_ARP_RegisterNpc")
	register_native("ARP_IsNpc","_ARP_IsNpc")
	
	register_native("ARP_PlayerReady","_ARP_PlayerReady")
	register_native("ARP_GetUserKey","_ARP_GetUserKey")
	
	register_native("ARP_GetUserWallet","_ARP_GetUserWallet")
	register_native("ARP_SetUserWallet","_ARP_SetUserWallet")
	register_native("ARP_GetUserBank","_ARP_GetUserBank")
	register_native("ARP_SetUserBank","_ARP_SetUserBank")
	register_native("ARP_GetUserHunger","_ARP_GetUserHunger")
	register_native("ARP_SetUserHunger","_ARP_SetUserHunger")
	register_native("ARP_GetUserAccess","_ARP_GetUserAccess")
	register_native("ARP_SetUserAccess","_ARP_SetUserAccess")
	
	register_native("ARP_GetJobsNum","_ARP_GetJobsNum")
	register_native("ARP_GetJobName","_ARP_GetJobName")
	register_native("ARP_GetJobSalary","_ARP_GetJobSalary")
	register_native("ARP_GetJobAccess","_ARP_GetJobAccess")
	register_native("ARP_GetUserJobId","_ARP_GetUserJobId")
	register_native("ARP_SetUserJobId","_ARP_SetUserJobId")
	register_native("ARP_SetUserJobRight","_ARP_SetUserJobRight")
	register_native("ARP_GetUserJobRight","_ARP_GetUserJobRight")
	register_native("ARP_ValidJobId","_ARP_ValidJobId")
	register_native("ARP_FindJobId","_ARP_FindJobId")
	register_native("ARP_AddJob","_ARP_AddJob")
	register_native("ARP_DeleteJob","_ARP_DeleteJob")
	
	register_native("ARP_RegisterItem","_ARP_RegisterItem")
	register_native("ARP_ValidItemId","_ARP_ValidItemId")
	register_native("ARP_FindItemId","_ARP_FindItemId")
	register_native("ARP_GetItemName","_ARP_GetItemName")
	//register_native("ARP_GetUserItemId","_ARP_GetUserItemId")
	register_native("ARP_GetUserItemNum","_ARP_GetUserItemNum")
	register_native("ARP_GetUserItems","_ARP_GetUserItems")
	register_native("ARP_SetUserItemNum","_ARP_SetUserItemNum")
	register_native("ARP_ForceUseItem","_ARP_ForceUseItem")
	register_native("ARP_ItemSet","_ARP_ItemSet")
	register_native("ARP_ItemDone","_ARP_ItemDone")
	register_native("ARP_H9Toast","_ARP_H9Toast")
	
	// H9: the team of a player and the names of the teams (include\ApolloRP_H9Teams.inc)
	register_native("ARP_H9_TeamOf","_ARP_H9_TeamOf")
	register_native("ARP_H9_TeamName","_ARP_H9_TeamName")

	// H9: the item menu's paths for the inventory window, and what it needs of the core
	register_native("ARP_UserUseItem","_ARP_UserUseItem")
	register_native("ARP_UserGiveItem","_ARP_UserGiveItem")
	register_native("ARP_UserDropItem","_ARP_UserDropItem")
	register_native("ARP_UserShowItem","_ARP_UserShowItem")
	register_native("ARP_DropPack","_ARP_DropPack")
	register_native("ARP_GetItemInfo","_ARP_GetItemInfo")
	register_native("ARP_InvRoom","_ARP_InvRoom")
	register_native("ARP_SaveUser","_ARP_SaveUser")
	
	register_native("ARP_AddCommand","_ARP_AddCommand")
	
	register_native("ARP_AddHudItem","_ARP_AddHudItem")
	register_native("ARP_AddHudItemKind","_ARP_AddHudItemKind")
	
	register_native("ARP_GetPayday","_ARP_GetPayday")
	
	register_native("ARP_ValidProperty","_ARP_ValidProperty")
	register_native("ARP_ValidPropertyName","_ARP_ValidPropertyName")
	register_native("ARP_ValidDoor","_ARP_ValidDoor")
	register_native("ARP_ValidDoorName","_ARP_ValidDoorName")
	register_native("ARP_AddProperty","_ARP_AddProperty")
	register_native("ARP_DeleteProperty","_ARP_DeleteProperty")
	register_native("ARP_AddDoor","_ARP_AddDoor")
	register_native("ARP_DeleteDoor","_ARP_DeleteDoor")
	register_native("ARP_PropertyNum","_ARP_PropertyNum")
	register_native("ARP_DoorNum","_ARP_DoorNum")
	register_native("ARP_DoorMatch","_ARP_DoorMatch")
	register_native("ARP_PropertyMatch","_ARP_PropertyMatch")
	register_native("ARP_PropertyGetInternalName","_ARP_PropertyGetInternalName")
	register_native("ARP_PropertyGetExternalName","_ARP_PropertyGetExternalName")
	register_native("ARP_PropertySetExternalName","_ARP_PropertySetExternalName")
	register_native("ARP_PropertyGetOwnerName","_ARP_PropertyGetOwnerName")
	register_native("ARP_PropertySetOwnerName","_ARP_PropertySetOwnerName")
	register_native("ARP_PropertyGetOwnerAuth","_ARP_PropertyGetOwnerAuth")
	register_native("ARP_PropertySetOwnerAuth","_ARP_PropertySetOwnerAuth")
	register_native("ARP_PropertyGetPrice","_ARP_PropertyGetPrice")
	register_native("ARP_PropertySetPrice","_ARP_PropertySetPrice")
	register_native("ARP_PropertyGetLocked","_ARP_PropertyGetLocked")
	register_native("ARP_PropertySetLocked","_ARP_PropertySetLocked")
	register_native("ARP_PropertyGetAccess","_ARP_PropertyGetAccess")
	register_native("ARP_PropertySetAccess","_ARP_PropertySetAccess")
	register_native("ARP_PropertyGetProfit","_ARP_PropertyGetProfit")
	register_native("ARP_PropertySetProfit","_ARP_PropertySetProfit")
	register_native("ARP_PropertyAddAccess","_ARP_PropertyAddAccess")
	register_native("ARP_PropertyRemoveAccess","_ARP_PropertyRemoveAccess")
	register_native("ARP_PropertyClearAccess","_ARP_PropertyClearAccess")
	
	//register_native("ARP_RegisterRob","_ARP_RegisterRob")
	//register_native("ARP_Rob","_ARP_Rob")
	
	register_native("ARP_ThrowError","_ARP_ThrowError")
	register_native("ARP_ClientPrint","_ARP_ClientPrint")
	
	register_native("ARP_CallEvent","_ARP_CallEvent")
	register_native("ARP_RegisterEvent","_ARP_RegisterEvent")
	
	register_native("ARP_ClassLoad","_ARP_ClassLoad")
	register_native("ARP_ClassSave","_ARP_ClassSave")
	register_native("ARP_ClassSaveHook","_ARP_ClassSaveHook")
	register_native("ARP_ClassDeleteKey","_ARP_ClassDeleteKey")
	register_native("ARP_ClassDestroy","_ARP_ClassDestroy")
	
	register_native("ARP_SetUserSpeed","_ARP_SetUserSpeed")
	//register_native("ARP_GetUserSpeed","_ARP_GetUserSpeed")
	
	register_native("ARP_AddMenuItem","_ARP_AddMenuItem")
}

public _ARP_SetUserSpeed(Plugin,Params)
{
	if(Params != 3)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 3",Params)
		return PLUGIN_CONTINUE
	}
	
	new id = get_param(1),Float:Value = get_param_f(3)
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"Player not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	switch(Speed:get_param(2))
	{
		case Speed_None:
		{
			TravTrieDeleteKeyEx(g_SpeedTrie[id],Plugin)
			
			if(g_SpeedOverridePlugin[id] == Plugin)
			{
				g_SpeedOverride[id] = 0.0
				g_SpeedOverridePlugin[id] = 0
			}
		}
		case Speed_Override:
		{
			if(g_SpeedOverridePlugin[id] && g_SpeedOverridePlugin[id] != Plugin)
				return FAILED
			
			g_SpeedOverride[id] = Value
			g_SpeedOverridePlugin[id] = Plugin
		}
		case Speed_Mul:
		{
			if(Value < 0.001)
				Value = 0.001
			
			new Float:PrevSpeed
			if(TravTrieGetCellEx(g_SpeedTrie[id],Plugin,PrevSpeed) && PrevSpeed)
				// Compound it with whatever was set before.
				Value *= PrevSpeed
			
			if(Value < 1.001 && Value > 0.999 )
				TravTrieDeleteKeyEx(g_SpeedTrie[id],Plugin)
			else
				TravTrieSetCellEx(g_SpeedTrie[id],Plugin,Value)
		}
	}
	
	// Fake a reset in case client_PreThink() skips.
	set_user_maxspeed(id,g_MaxSpeed[id])
	
	return SUCCEEDED
}

public _ARP_SqlMode(Plugin,Params)
{
	if(Params)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 0",Params)
		return PLUGIN_CONTINUE
	}
	
	return _:g_SqlMode
}

public _ARP_PlayerReady(Plugin,Params)
{
	if(Params < 1)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 1",Params)
		return PLUGIN_CONTINUE
	}
	
	new id = get_param(1)
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"Player not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return g_GotInfo[id] >= STD_USER_QUERIES
}

public _ARP_Log(Plugin,Params)
{
	if(Params < 1)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 1",Params)
		return PLUGIN_CONTINUE
	}
	
	vdformat(g_Query,4095,1,2)
	
	return UTIL_ARP_Log(Plugin,g_Query)
}

UTIL_ARP_Log(Plugin,Message[])
{
	new PluginName[64],Garbage[1]
	get_plugin(Plugin,Garbage,0,PluginName,63,Garbage,0,Garbage,0,Garbage,0)
	
	replace(PluginName,63,"ARP - ","")
	
	switch(get_pcvar_num(p_Log))
	{
		case 1 : log_amx("[ARP - %s] %s",PluginName,g_Query)
		case 2 : 
		{
			new Time[128],LogsDir[64],File[128]
			get_localinfo("amxx_logs",LogsDir,63)
			
			get_time("%m-%d-%Y",Time,127)
			format(File,127,"%s/arp/%s.log",LogsDir,Time)
			
			log_to_file(File,"[ARP - %s] %s",PluginName,Message)
		}
		case 3 : 
		{
			new File[128],LogsDir[64]
			get_localinfo("amxx_logs",LogsDir,63)
			
			replace_all(PluginName,63," ","")
			strtolower(PluginName)
			format(File,127,"%s/arp/%s.log",LogsDir,Message)
			
			log_to_file(File,g_Query)
		}
		default : return FAILED
	}
	
	return SUCCEEDED
}

public _ARP_FileOpen(Plugin,Params)
{
	if(Params != 2)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 2",Params)
		return PLUGIN_CONTINUE
	}
	
	new FileName[128],Mode[24]
	get_string(1,FileName,127)
	get_string(2,Mode,23)
	
	return UTIL_ARP_FileOpen(FileName,Mode)
}

UTIL_ARP_FileOpen(FileName[],Mode[])
{
	new FilePath[256]
	get_configsdir(FilePath,255)
	add(FilePath,255,"/arp/")
	new OrigLen = strlen(FilePath)
	
	new MapName[33]
	get_mapname(MapName,32)
	
	add(FilePath,255,"maps/")
	add(FilePath,255,MapName)
	add(FilePath,255,"/")
	add(FilePath,255,FileName)
	
	new File
	if(file_exists(FilePath) && (File = fopen(FilePath,Mode)))
		return File
	
	FilePath[OrigLen] = 0
	
	add(FilePath,255,FileName)
	
	if(file_exists(FilePath))
		return fopen(FilePath,Mode)
	
	return FAILED
}

public _ARP_RegisterAddon(Plugin,Params)
{
	if(Params != 1)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 1",Params)
		return PLUGIN_CONTINUE
	}
	
	new Description[128]
	get_string(1,Description,127)
	TravTrieSetStringEx(g_PluginTrie,Plugin,Description)
	
	return SUCCEEDED
}

public _ARP_AddonTrie(Plugin,Params)
{
	if(Params != 0)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 0",Params)
		return PLUGIN_CONTINUE
	}
	
	return _:g_PluginTrie
}

public _ARP_AddonLoaded(Plugin,Params)
{
	if(Params != 1)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 1",Params)
		return PLUGIN_CONTINUE
	}
	
	new Addon[64]
	get_string(1,Addon,63)
	
	new Name[64],Garbage[1],travTrieIter:Iter = GetTravTrieIterator(g_PluginTrie),Plugin,Return
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKeyEx(Iter,Plugin)
		// just to advance the iterator
		ReadTravTrieString(Iter,Garbage,0)
		
		get_plugin(Plugin,Garbage,0,Name,63,Garbage,0,Garbage,0,Garbage,0)
		replace(Name,63,"ARP - ","")
		
		if(equali(Addon,Name))
		{
			Return = Plugin
			break
		}
	}
	DestroyTravTrieIterator(Iter)
	
	return Return
}

public _ARP_CleverQueryBackend(Plugin,Params)
{
	if(Params != 5)
	{
		log_error(AMX_ERR_NATIVE,"Invalid params passed: %d - Expected: 5",Params)
		return PLUGIN_CONTINUE
	}
	
	new Handle:Tuple = Handle:get_param(1),Handler[128],Data[1024],Len = min(1023,get_param(5))
	get_string(2,Handler,127)
	get_string(3,g_Query,4095)
	get_array(4,Data,Len)
	
	return _ARP_CleverQuery(Plugin,Tuple,Handler,g_Query,Data,Len)
}

public ClearHandle(Handle:Query)
	SQL_FreeHandle(Query)

CleverQueryFunction(PluginGiven,HandlerS[],FailState,Handle:Query,Error[],Errcode,PassData[],Len,Float:HangTime)
{
	new Forward = CreateOneForward(PluginGiven,HandlerS,FP_CELL,FP_CELL,FP_STRING,FP_CELL,FP_ARRAY,FP_CELL,FP_CELL),CurArray = Len ? PrepareArray(PassData,Len) : 0,Return
	if(!Forward || !ExecuteForward(Forward,Return,FailState,Query,Error,Errcode,CurArray,Len,HangTime))
	{
		log_error(AMX_ERR_NATIVE,"Could not execute forward to %d: %s (%d)",PluginGiven,HandlerS,Forward)
		return
	}
	DestroyForward(Forward)
}

UTIL_ARP_CleverQuery(PluginGiven,Handle:Tuple,Handler[],QueryS[],Data[] = "",Len = 0)
{
	if(g_SqlHandle == Empty_Handle) return FAILED
	return _ARP_CleverQuery(PluginGiven,Tuple,Handler,QueryS,Data,Len) ? SQL_ThreadQuery(Tuple,Handler,QueryS,Data,Len) : PLUGIN_HANDLED
}

_ARP_CleverQuery(Plugin,Handle:Tuple,Handler[],QueryS[],Data[] = "",Len = 0)
{
	if(!get_playersnum() || g_PluginEnd /*|| g_SqlMode == SQLITE*/)
	{
		new Error[512],ErrorCode,Handle:SqlConnection = SQL_Connect(Tuple,ErrorCode,Error,511)
		if(SqlConnection == Empty_Handle)
		{
			CleverQueryFunction(Plugin,Handler,TQUERY_CONNECT_FAILED,Empty_Handle,Error,ErrorCode,Data,Len,0.0)
			return PLUGIN_CONTINUE
		}
		
		new Handle:Query = SQL_PrepareQuery(SqlConnection,"%s",QueryS)
		if(!SQL_Execute(Query))
		{
			ErrorCode = SQL_QueryError(Query,Error,511)
			CleverQueryFunction(Plugin,Handler,TQUERY_QUERY_FAILED,Query,Error,ErrorCode,Data,Len,0.0)
			return PLUGIN_CONTINUE
		}
		
		CleverQueryFunction(Plugin,Handler,TQUERY_SUCCESS,Query,"",0,Data,Len,0.0)
		
		SQL_FreeHandle(Query)
		SQL_FreeHandle(SqlConnection)
		
		//set_task(0.1,"ClearHandle",_:Query)
		//set_task(0.1,"ClearHandle",_:SqlConnection)
		
		return PLUGIN_CONTINUE
	}
	
	return PLUGIN_HANDLED
}

public _ARP_ClassLoad(Plugin,Params)
{
	if(Params != 4)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Param[64],Handler[64],Temp[128],Table[64],ClassName[128]//,Len = min(4095,get_param(4))
	get_string(1,Param,63)
	get_string(2,Handler,63)
	get_string(3,g_Query,4095)
	get_string(4,Table,63)
	
	if(!Table[0])
		copy(Table,63,g_DataTable)
	
	format(ClassName,127,"%s|%s",Table,Param)
	
	//g_Query[0] = Len
	
	format(Temp,127,"%d|%s",Plugin,Handler)
	
	new travTrieIter:Iter = GetTravTrieIterator(g_ClassArray),Cell,ClassHeader[64],Loaded,TravTrie:CurTrie,TravTrie:PluginTrie,Flag,ReadTable[64],Garbage[1]
	while(MoreTravTrie(Iter))
	{		
		ReadTravTrieKey(Iter,ClassHeader,63)
		ReadTravTrieCell(Iter,Cell)
		
		strtok(ClassHeader,ReadTable,63,Garbage,0,'|')
		if(Table[0] && equali(ReadTable,Table))
			Flag = 1
		
		if(equali(ClassName,ClassHeader))
		{			
			TravTrieGetCell(g_ClassArray,ClassHeader,CurTrie)
			
			TravTrieGetHCell(CurTrie,"/plugins",PluginTrie)
			TravTrieSetCellEx(PluginTrie,Plugin,1)
			
			TravTrieGetHCell(CurTrie,"/loaded",Loaded)
			if(!Loaded)
			{				
				new TravTrie:CallsTrie
				TravTrieGetHCell(CurTrie,"/calls",CallsTrie)
				
				TravTrieSetString(CallsTrie,Temp,g_Query)
				
				return -1
			}
				
			/*new Forward = CreateOneForward(Plugin,"ARP_ClassLoaded",FP_CELL,FP_STRING),Return
			if(!Forward || !ExecuteForward(Forward,Return,_:CurTrie,Class))
			{
				format(g_Query,4095,"Could not execute ARP_ClassLoaded forward")
				return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
			}
			DestroyForward(Forward)*/
			
			new Forward = CreateOneForward(Plugin,Handler,FP_CELL,FP_STRING,FP_STRING),Return
			//new CurArray = PrepareArray(g_Query[1],Len)
			if(!Forward || !ExecuteForward(Forward,Return,_:CurTrie,ClassHeader,g_Query))
			{
				format(g_Query,4095,"Could not execute %s forward to %d",Handler,Plugin)
				return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
			}				
			DestroyForward(Forward)
			
			return PLUGIN_HANDLED
		}
	}
	DestroyTravTrieIterator(Iter)
	
	if(!Flag && !equali(g_DataTable,Table))
	{		
		static Query[512]
		switch(g_SqlMode)
		{
			case MYSQL:
				format(Query,511,"CREATE TABLE IF NOT EXISTS %s (classkey VARCHAR(64),value TEXT,UNIQUE KEY (classkey))",Table)
			case SQLITE:
				format(Query,511,"CREATE TABLE IF NOT EXISTS %s (classkey VARCHAR(64),value TEXT,UNIQUE (classkey))",Table)
		}
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",Query)
	}
	
	new Buffer[128] //,TravTrie:CallTrie = TravTrieCreate()
	//SQL_QuoteString(g_SqlHandle,Buffer,127,Param)
	copy(Buffer,126,Param)
	
	//server_print("Setting array: %d | %s | %s | %d",CallTrie,Handler,g_Query,Len)
	new TravTrie:CallTrie = TravTrieCreate()
	PluginTrie = TravTrieCreate()
	TravTrieSetCellEx(PluginTrie,Plugin,1)
	TravTrieSetString(CallTrie,Temp,g_Query)
	
	CurTrie = TravTrieCreate()
	TravTrieSetCell(g_ClassArray,ClassName,CurTrie)
	TravTrieSetHCell(CurTrie,"/loaded",0)
	TravTrieSetHCell(CurTrie,"/saving",0)
	TravTrieSetHCell(CurTrie,"/lastquery",0)
	TravTrieSetHCell(CurTrie,"/plugins",PluginTrie)
	TravTrieSetHCell(CurTrie,"/changed",TravTrieCreate())
	TravTrieSetHCell(CurTrie,"/calls",CallTrie)
	TravTrieSetHCell(CurTrie,"/savetrie",TravTrieCreate())
	TravTrieSetString(CurTrie,"/table",Table)
	//TravTrieSetString(CurTrie,"/table",Table)
	
	Buffer[127] = _:CurTrie
	
	new OldBuffer[128]
	for(new i;i < 128;i++)
		OldBuffer[i] = Buffer[i]
	ARP_SqlEscape(Buffer,charsmax(Buffer))
	format(g_Query,4095,"SELECT * FROM %s WHERE classkey LIKE '%s|%%'",Table,Buffer)
	//UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"ClassLoadHandle",g_Query,Buffer,128)
	SQL_ThreadQuery(g_SqlHandle,"ClassLoadHandle",g_Query,OldBuffer,128)
	
	return PLUGIN_CONTINUE
}

public ClassLoadHandle(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{	
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	new ClassKey[128],Key[64],Value[128],Garbage[2],TravTrie:CurTrie = TravTrie:Data[127],TravTrie:CallsTrie
	while(SQL_MoreResults(Query))
	{
		SQL_ReadResult(Query,0,ClassKey,127)
		strtok(ClassKey,Garbage,1,Key,63,'|')
		SQL_ReadResult(Query,1,Value,127)
		
		TravTrieSetString(CurTrie,Key,Value)
		
		SQL_NextRow(Query)
	}
	
	TravTrieSetHCell(CurTrie,"/loaded",1)
	
	TravTrieGetHCell(CurTrie,"/calls",CallsTrie)
	new travTrieIter:Iter = GetTravTrieIterator(CallsTrie),Handler[64],Forward,Return,Temp[64],PluginStr[10],Plugin
	while(MoreTravTrie(Iter))
	{		
		ReadTravTrieKey(Iter,Temp,63)
		strtok(Temp,PluginStr,9,Handler,63,'|')
		Plugin = str_to_num(PluginStr)
		ReadTravTrieString(Iter,g_Query,4095)
		
		Forward = CreateOneForward(Plugin,Handler,FP_CELL,FP_STRING,FP_STRING)
		//CurArray = PrepareArray(g_Query[1],g_Query[0])
		if(!Forward || !ExecuteForward(Forward,Return,_:CurTrie,Data,g_Query))
		{
			format(g_Query,4095,"Could not execute %s forward to %d",Handler,Plugin)
			return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
		}
		DestroyForward(Forward)
	}
	DestroyTravTrieIterator(Iter)
	
	TravTrieDestroy(CallsTrie)
	
	Forward = CreateMultiForward("ARP_ClassLoaded",ET_IGNORE,FP_CELL,FP_STRING)
	if(!Forward || !ExecuteForward(Forward,Return,_:CurTrie,Data))
	{
		format(g_Query,4095,"Could not execute ARP_ClassLoaded forward")
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
	}
	DestroyForward(Forward)
	
	return PLUGIN_CONTINUE
}

public _ARP_ClassSave(ThisPlugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,ThisPlugin)
	}
	
	new TravTrie:ClassNum = TravTrie:get_param_byref(1),ProcClass[128],Close = get_param(2),travTrieIter:Iter = GetTravTrieIterator(g_ClassArray),TrieClass[64],TravTrie:CurTrie,TravTrie:PluginTrie,ClassName[64]
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,TrieClass,63)
		ReadTravTrieCell(Iter,CurTrie)
		
		copy(ClassName,63,TrieClass[containi(TrieClass,"|") + 1])
		
		if(CurTrie == ClassNum && !task_exists(_:CurTrie))
		{
			//SQL_QuoteString(g_SqlHandle,ProcClass,127,Class)
			copy(ProcClass[1],126,TrieClass)
			
			//format(g_Query,4095,"DELETE FROM %s WHERE classkey LIKE '%s|%%'",g_DataTable,ProcClass)
			//UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
			
			ProcClass[0] = _:CurTrie
			
			new TravTrie:SaveTrie
			TravTrieGetHCell(CurTrie,"/savetrie",SaveTrie)
			
			new travTrieIter:saveIter = GetTravTrieIterator(SaveTrie),Handler[64],Temp[128],PluginStr[10],Plugin,Forward,Return
			//server_print("ITERATOR: %d, SAVETRIE: %d",Iter,SaveTrie)
			while(MoreTravTrie(saveIter))
			{
				ReadTravTrieKey(saveIter,Temp,127)
				ReadTravTrieString(saveIter,g_Query,4095)
				
				strtok(Temp,PluginStr,9,Handler,63,'|')
				Plugin = str_to_num(PluginStr)
				
				//server_print("Calling forward to: %d , %s",Plugin,Handler)
				
				Forward = CreateOneForward(Plugin,Handler,FP_CELL,FP_STRING,FP_STRING)
				if(!Forward || !ExecuteForward(Forward,Return,CurTrie,ClassName,g_Query))
				{
					format(g_Query,4095,"Could not register forward")
					return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,g_Plugin)
				}
				DestroyForward(Forward)
			}
			DestroyTravTrieIterator(saveIter)
			
			//if(_CallEvent("Class_Save",ClassName,128))
			//	return FAILED
			
			if(Close)
			{					
				//server_print("marking as closed: %s / %d",TrieClass,ThisPlugin)
				
				TravTrieGetHCell(CurTrie,"/plugins",PluginTrie)
				TravTrieDeleteKeyEx(PluginTrie,ThisPlugin)
				
				set_param_byref(1,_:Invalid_TravTrie)
			}
			
			SaveClass(CurTrie,ProcClass[1])
			
			return SUCCEEDED
		}
	}
	DestroyTravTrieIterator(Iter)
	
	return SUCCEEDED
}

public SaveClass(TravTrie:CurTrie,ProcClass[])
{	
	new Saving
	TravTrieGetHCell(CurTrie,"/saving",Saving)
	if(Saving)
		return SUCCEEDED
	
	new TravTrie:ChangedTrie,Table[64],ClassName[64]//,Garbage[1]
	TravTrieGetHCell(CurTrie,"/changed",ChangedTrie)
	//TravTrieGetString(CurTrie,"/table",Table,63)
	//TravTrieGetHCell(CurTrie,"/table",TableTrie)
	//TravTrieGetStringEx(TableTrie,0,Table,63)
	
	strtok(ProcClass,Table,63,ClassName,63,'|')
	
	TravTrieSetHCell(CurTrie,"/saving",1)
	
	new Key[128],Data[64],TrieClass[64]
	Data[1] = _:CurTrie
	
	copy(Data[2],60,ProcClass)
	
	//format(g_Query,4095,"DELETE FROM %s WHERE classkey LIKE '%s|%%'",g_DataTable,ProcClass)
	//UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	new travTrieIter:Iter = GetTravTrieIterator(CurTrie),Changed,ChangedNum
	
	// Run through it once to get the number
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,TrieClass,63)
		ReadTravTrieString(Iter,g_Query,4095)
		
		TravTrieGetCell(ChangedTrie,TrieClass,Changed)
		
		if(TrieClass[0] != '^n' && TrieClass[0] != '/' && Changed) ChangedNum++
		
		Changed = 0
	}
	
	TravTrieSetHCell(CurTrie,"/lastquery",ChangedNum)
	DestroyTravTrieIterator(Iter)
	
	Iter = GetTravTrieIterator(CurTrie)
	while(MoreTravTrie(Iter))
	{				
		ReadTravTrieKey(Iter,TrieClass,63)
		ReadTravTrieString(Iter,g_Query,4095)
		TravTrieGetCell(ChangedTrie,TrieClass,Changed)
		
		if(TrieClass[0] == '^0' || TrieClass[0] == '/' || !Changed) continue
		
		TravTrieSetCell(ChangedTrie,TrieClass,0)
		
		Changed = 0
		
		//SQL_QuoteString(g_SqlHandle,Key,127,TrieClass)
		copy(Key,127,TrieClass)
		//SQL_QuoteString(g_SqlHandle,g_Cache,4095,g_Query)
		copy(g_Cache,4095,g_Query)
		
		Data[0]++
		
		ARP_SqlEscape(ClassName,127)
		ARP_SqlEscape(Key,127)
		ARP_SqlEscape(g_Cache,4095)
		//replace_all(ClassName,127,"'","\'")
		//replace_all(Key,127,"'","\'")
		//replace_all(g_Cache,4095,"'","\'")
		
		switch(g_SqlMode)
		{
			case MYSQL: 
				format(g_Query,4095,"INSERT INTO %s VALUES ('%s|%s','%s') ON DUPLICATE KEY UPDATE value='%s'",Table,ClassName,Key,g_Cache,g_Cache)
			case SQLITE:
				format(g_Query,4095,"REPLACE INTO %s VALUES ('%s|%s','%s')",Table,ClassName,Key,g_Cache)
		}
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"ClassSaveHandle",g_Query,Data,64)
	}
	DestroyTravTrieIterator(Iter)
	
	new TravTrie:PluginTrie,TravTrie:SaveTrie
	TravTrieGetHCell(CurTrie,"/plugins",PluginTrie)
	TravTrieGetHCell(CurTrie,"/savetrie",SaveTrie)
	
// Hawk552: Do this later no matter what driver we're running.
#if 000
	if(!ChangedNum && !TravTrieSize(PluginTrie) && g_SqlMode == SQLITE)
	{				
		TravTrieDestroy(PluginTrie)
		TravTrieDestroy(CurTrie)
		TravTrieDestroy(ChangedTrie)
		TravTrieDestroy(SaveTrie)
			
		TravTrieDeleteKey(g_ClassArray,ProcClass)
	}
#endif
	
	if(!ChangedNum)
		ClassSaveHandle(0,Empty_Handle,"",0,Data,64)
	
	return SUCCEEDED
}

public ClassSaveHandle(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		SQL_GetQueryString(Query,g_Query,4095)		
		format(g_Query,4095,"Internal error: %s^nQuery: %s",Error,g_Query)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	// H9: "/lastquery" counts the answers still to come, and the save is done when the count is spent: the SQL module hands
	// over the answers that finished in one frame last in, first out, so the numbers of the queries are no order of the answers
	new Pending,TravTrie:CurTrie = TravTrie:Data[1]
	TravTrieGetHCell(CurTrie,"/lastquery",Pending)
	TravTrieSetHCell(CurTrie,"/lastquery",--Pending)
	
	if(Pending <= 0)
	{
		TravTrieSetHCell(CurTrie,"/saving",0)
	
		new TravTrie:PluginTrie,TravTrie:ChangedTrie,TravTrie:SaveTrie
		TravTrieGetHCell(CurTrie,"/plugins",PluginTrie)
		TravTrieGetHCell(CurTrie,"/changed",ChangedTrie)
		TravTrieGetHCell(CurTrie,"/savetrie",SaveTrie)

		//server_print("trie size: %d [%s]", TravTrieSize(PluginTrie),Data[2])
		if(!TravTrieSize(PluginTrie) && !g_PluginEnd)
		{
			//server_print("destroying %s",Data[2])
			
			TravTrieDestroy(PluginTrie)
			TravTrieDestroy(CurTrie)
			TravTrieDestroy(ChangedTrie)
			TravTrieDestroy(SaveTrie)
			
			TravTrieDeleteKey(g_ClassArray,Data[2])
		}
		
		//if(g_PluginEnd && g_LastOverallQuery == Data[2]) TravTrieDestroy(g_ClassArray)
	}
	
	return PLUGIN_CONTINUE
}

public _ARP_ClassSaveHook(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new TravTrie:CurTrie = TravTrie:get_param(1),Handler[64],Temp[128],TravTrie:SaveTrie
	get_string(2,Handler,63)
	get_string(3,g_Query,4095)
	
	format(Temp,127,"%d|%s",Plugin,Handler)
	
	TravTrieGetHCell(CurTrie,"/savetrie",SaveTrie)
	TravTrieSetString(SaveTrie,Temp,g_Query)
	
	return SUCCEEDED
}

public _ARP_ClassDeleteKey(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new TravTrie:ClassNum = TravTrie:get_param(1),Key[64]
	get_string(2,Key,63)
	
	if(Key[0] == '/' || Key[0] == '^n' || !ClassNum) 
		return FAILED
	
	new travTrieIter:Iter = GetTravTrieIterator(g_ClassArray),Cell,Name[64],Table[64]
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Name,63)
		ReadTravTrieCell(Iter,Cell)
		if(Cell == _:ClassNum)		
		{
			strtok(Name,"",0,Name,63,'|')
			break
		}
	}
	DestroyTravTrieIterator(Iter)
	
	TravTrieGetString(ClassNum,"/table",Table,63)
	
	//if(!Name[0])
	//	return FAILED
	
	new KeyDeleted = TravTrieDeleteKey(ClassNum,Key)
	
	ARP_SqlEscape(Name,63)
	ARP_SqlEscape(Key,63)
	
	format(g_Query,4095,"DELETE FROM %s WHERE classkey='%s|%s'",Table,Name,Key)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	return KeyDeleted
}

public _ARP_ClassDestroy(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new TravTrie:CurTrie = TravTrie:get_param(1)
	
	new travTrieIter:Iter = GetTravTrieIterator(g_ClassArray),Cell,Name[64],Table[64]
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Name,63)
		ReadTravTrieCell(Iter,Cell)
		if(Cell == _:CurTrie)			
			break
	}
	DestroyTravTrieIterator(Iter)
	
	TravTrieGetString(CurTrie,"/table",Table,63)
	
	new Quoted[130]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),Name)
	
	format(g_Query,4095,"DELETE FROM %s WHERE classkey LIKE '%s|%%'",Table,Quoted)
	
	new TravTrie:PluginTrie,TravTrie:ChangedTrie,TravTrie:SaveTrie
	TravTrieGetHCell(CurTrie,"/plugins",PluginTrie)
	TravTrieGetHCell(CurTrie,"/changed",ChangedTrie)
	TravTrieGetHCell(CurTrie,"/savetrie",SaveTrie)
		
	TravTrieDestroy(PluginTrie)
	TravTrieDestroy(CurTrie)
	TravTrieDestroy(ChangedTrie)
	TravTrieDestroy(SaveTrie)
	
	TravTrieDeleteKey(g_ClassArray,Name)
	
	return SUCCEEDED
}

public _ARP_AddMenuItem(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(!g_MenuAccepting[id])
	{
		format(g_Query,4095,"The menu only accepts items during the 'clientmenu' event.")
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Name[33],Handler[64],Data[64]
	get_string(2,Name,32)
	get_string(3,Handler[1],62)
	Handler[0] = Plugin
	
	Data[0] = Plugin
	copy(Data[1],62,Name)
	
	return _CallEvent("Menu_AddItem",Data,63) ? PLUGIN_CONTINUE : _:TravTrieSetString(g_MenuArray[id],Name,Handler)
}

public _ARP_CallEvent(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Len = min(4095,get_param(3)),Name[33]
	get_array(2,g_Query,Len)
	get_string(1,Name,32)

	return _CallEvent(Name,g_Query,Len)
}

_CallEvent(Name[],Data[],Length)
{
	new travTrieIter:Iter = GetTravTrieIterator(g_EventTrie),Event[128],Key[128],Plugin,PluginStr[12],Handler[128],Forward,Return
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Key,127)
		ReadTravTrieString(Iter,Event,127)
		
		if(!equal(Event,Name))
			continue
		
		strtok(Key,PluginStr,11,Handler,127,'|')
		Plugin = str_to_num(PluginStr)
		
		Forward = CreateOneForward(Plugin,Handler,FP_STRING,FP_ARRAY,FP_CELL)
		if(!Forward)
		{
			format(g_Query,4095,"Could not register forward")
			return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,g_Plugin)
		}
		
		new CurArray = PrepareArray(Data,Length)
	
		if(!ExecuteForward(Forward,Return,Event,CurArray,Length))
		{
			format(g_Query,4095,"Could not execute forward: %s in %d",Handler,Plugin)
			return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,g_Plugin)
		}
		
		DestroyForward(Forward)
		
		if(Return)
			return Return
	}
	DestroyTravTrieIterator(Iter)
	
	Forward = CreateMultiForward("ARP_Event",ET_STOP2,FP_STRING,FP_ARRAY,FP_CELL)
	if(!Forward)
	{
		format(g_Query,4095,"Could not register forward")
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,g_Plugin)
	}
	
	new CurArray = PrepareArray(Data,Length)
	
	if(!ExecuteForward(Forward,Return,Name,CurArray,Length))
	{
		format(g_Query,4095,"Could not execute forward")
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,g_Plugin)
	}
	
	DestroyForward(Forward)
	
	return Return
}

public _ARP_RegisterEvent(Plugin,Params)
{
	if(Params < 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new travTrieIter:Iter = GetTravTrieIterator(g_EventTrie),Event[128],Handler[128],Key[128],Dummy[2]
	get_string(1,Event,127)
	get_string(2,Handler,127)
	
	format(Handler,127,"%d|%s",Plugin,Handler)
	
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Key,127)
		ReadTravTrieString(Iter,Dummy,1)
		
		// It's okay if the event repeats as multiple plugins can register it
		if(equali(Handler,Key))
			return FAILED
	}
	
	DestroyTravTrieIterator(Iter)
	
	TravTrieSetString(g_EventTrie,Handler,Event)
	
	return SUCCEEDED
}

public _ARP_GetTable(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	switch(get_param(1))
	{
		case 0 :
			set_string(2,g_UserTable,get_param(3))
		case 1 :
			set_string(2,g_JobsTable,get_param(3))
		case 2 :
			set_string(2,g_PropertyTable,get_param(3))
		case 3 :
			set_string(2,g_DoorsTable,get_param(3))
		case 4 :
			set_string(2,g_KeysTable,get_param(3))
		case 5 :
			set_string(2,g_ItemsTable,get_param(3))
		case 6 :
			set_string(2,g_DataTable,get_param(3))
	}

	return SUCCEEDED
}

public _ARP_GetPayday(Plugin,Params)
	return g_Time / 10

public _ARP_Version(Plugin,Params)
{
	if(Params == 2)
		set_string(1,g_Version,get_param(2))
	else
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2 or more, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return SUCCEEDED
}

public _ARP_ClientPrint(Plugin,Params)
{
	if(Params < 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2 or more, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	get_string(2,g_Query,4095)
	
	if(!is_user_connected(id) && id)
	{
		format(g_Query,4095,"User is not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	vformat(g_Query,4095,g_Query,3)
	
	UTIL_ARP_ClientPrint(id,g_Query)
	
	return SUCCEEDED
}

public _ARP_GetConfigsdir(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	set_string(1,g_ConfigsDir,get_param(2))
	
	return SUCCEEDED
}

public _ARP_GetUserJobRight(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(is_user_connected(id))
		return g_JobRight[id]
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserJobRight(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),Rights = get_param(2),Set
	for(new Count;Count < JOB_ACCESSES;Count++)
		if(Rights & (1<<Count))
			Set |= (1<<Count)
	
	if(is_user_connected(id))
		return g_JobRight[id] = Set
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	return FAILED
}

public _ARP_ItemSet(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(is_user_connected(id))
		return g_ItemUse[id] ? FAILED : (g_ItemUse[id] = Plugin)
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_ValidItemId(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_ValidItemId(get_param(1))
}

public _ARP_ForceUseItem(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),ItemId = get_param(2),UseUp = get_param(3)
	
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(UseUp && !UTIL_ARP_GetUserItemNum(id,ItemId))
	{
		format(g_Query,4095,"User %d has none of item: %d",id,ItemId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(g_ItemUse[id] && UseUp)
		return FAILED
	
	if(UTIL_ARP_ValidItemId(ItemId))
		return ItemUse(id,ItemId,UseUp ? 1 : 0)
	
	format(g_Query,4095,"Invalid item id: %d",ItemId)
	return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
}

public _ARP_AddJob(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Name[33],Salary,IntAccess
	
	get_string(1,Name,32)
	Salary = get_param(2)
	IntAccess = get_param(3)
	
	new Results[1]
	ARP_FindJobId(Name,Results,1)
	
	if(Results[0])
	{
		Results[0] -= 1
		
		new TempName[33]
		array_get_string(array_get_int(g_JobsArray,Results[0]),1,TempName,32)
		
		format(g_Query,4095,"A job with a similar name already exists. User input: %s - Existing job: %s",Name,TempName)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_AddJob(Name,Salary,IntAccess) + 1
}

UTIL_ARP_AddJob(Name[],Salary,IntAccess)
{
	new Access[JOB_ACCESSES + 1]
	ARP_IntToAccess(IntAccess,Access,JOB_ACCESSES)
	
	#if defined DEBUG
	g_TotalQueries++
	#endif
	
	new FmtName[64]
	copy(FmtName,63,Name)
	ARP_SqlEscape(FmtName,63)
	
	format(g_Query,4095,"INSERT INTO %s VALUES ('%s','%d','%s')",g_JobsTable,FmtName,Salary,Access)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	new CurArray = array_create()
	array_set_int(g_JobsArray,g_JobsNum++,CurArray)
	
	array_set_string(CurArray,1,Name)
	array_set_int(CurArray,2,Salary)
	array_set_int(CurArray,3,IntAccess)
	
	return g_JobsNum - 1
}

public _ARP_DeleteJob(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(1) - 1
	
	if(!UTIL_ARP_ValidJobId(JobId))
	{
		format(g_Query,4095,"Invalid job id: %d",JobId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_DeleteJob(JobId)
}

UTIL_ARP_DeleteJob(JobId)
{
	new Players[MAX_PLAYERS],Playersnum,Player,Jobs[1]
	get_players(Players,Playersnum)
	
	if(!ARP_FindJobId("Unemployed",Jobs,1))
	{
		format(g_Query,4095,"Error finding ^"Unemployed^" job.")
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
	}
	
	new Unemployed = Jobs[0] - 1
	
	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		if(g_JobId[Player] == JobId)
		{
			g_JobId[Player] = Unemployed
			g_KeptJob[Player][0] = 0
		}
	}
	
	new Name[33]
	array_get_string(array_get_int(g_JobsArray,JobId),1,Name,32)
	
	ARP_SqlEscape(Name,32)
	format(g_Query,4095,"DELETE FROM %s WHERE name='%s'",g_JobsTable,Name)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	new JobArray = array_get_int(g_JobsArray,JobId)
	array_destroy(JobArray)
	array_set_int(g_JobsArray,JobId,-1)
	
	return SUCCEEDED
}

public _ARP_AddProperty(Plugin,Params)
{
	if(Params != 8)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 5, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new InternalName[64],ExternalName[64],OwnerName[33],OwnerAuth[36],Price,Locked,Access,Profit
	get_string(1,InternalName,63)
	get_string(2,ExternalName,63)
	get_string(3,OwnerName,32)
	get_string(4,OwnerAuth,35)
	Price = get_param(5)
	Locked = get_param(6)
	Access = get_param(7)
	Profit = get_param(8)
	
	if(UTIL_ARP_MatchProperty(InternalName) != -1)
	{
		format(g_Query,4095,"Property already exists: %s",InternalName)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new CurArray = array_create()
	array_set_int(g_PropertyArray,g_PropertyNum++,CurArray)
	
	array_set_string(CurArray,0,InternalName)
	array_set_string(CurArray,1,ExternalName)
	array_set_string(CurArray,2,OwnerName)
	array_set_string(CurArray,3,OwnerAuth)
	array_set_int(CurArray,4,Price)
	array_set_int(CurArray,5,Locked)
	array_set_int(CurArray,6,Access)
	array_set_int(CurArray,7,Profit)
	H9_ClearKeys(CurArray)
	array_set_int(CurArray,9,1)
	
	//format(g_Query,4095,"INSERT INTO %s VALUES ('%s','%s','','','%d','0','','0','','%s')",g_PropertyTable,Targetname,Name,Price,FakeMsg)
	//UTIL_ARP_CleverQuery(g_Plugin(g_SqlHandle,"IgnoreHandle",g_Query)
	
	return g_PropertyNum
}

public _ARP_DeleteProperty(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
		return FAILED
	
	new InternalName[33],FetchInternalName[33],CurArray,NextArray,PropArray = array_get_int(g_PropertyArray,Property)
	array_get_string(PropArray,0,InternalName,32)
	
	new NextInternalName[64],ExternalName[64],OwnerName[33],OwnerAuth[36]
	for(new Count = Property;Count < g_PropertyNum - 1;Count++)
	{
		NextArray = array_get_int(g_PropertyArray,Count + 1)
		array_get_string(NextArray,0,NextInternalName,63)
		array_get_string(NextArray,1,ExternalName,63)
		array_get_string(NextArray,2,OwnerName,32)
		array_get_string(NextArray,3,OwnerAuth,35)
		CurArray = array_get_int(g_PropertyArray,Count)
		array_set_string(CurArray,0,NextInternalName)
		array_set_string(CurArray,1,ExternalName)
		array_set_string(CurArray,2,OwnerName)
		array_set_string(CurArray,3,OwnerAuth)
		array_set_int(CurArray,4,array_get_int(NextArray,4))
		array_set_int(CurArray,5,array_get_int(NextArray,5))
		array_set_int(CurArray,6,array_get_int(NextArray,6))
		array_set_int(CurArray,7,array_get_int(NextArray,7))
		H9_CopyKeys(CurArray,NextArray)
		array_set_int(CurArray,9,array_get_int(NextArray,9))
		
		array_set_int(g_PropertyArray,Count,NextArray)
	}
	
	array_destroy(PropArray)
	array_delete(g_PropertyArray,--g_PropertyNum)
	
	new Quoted[72]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),InternalName)
	
	format(g_Query,4095,"DELETE FROM %s WHERE internalname='%s'",g_PropertyTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	for(new Count;Count < g_DoorNum;Count++)
	{
		CurArray = array_get_int(g_DoorArray,Count)
		array_get_string(g_DoorArray,2,FetchInternalName,32)
		
		if(equali(InternalName,FetchInternalName))
			UTIL_ARP_DeleteDoor(Count)
	}
	
	return SUCCEEDED
}

public _ARP_AddDoor(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,511,"Parameters do not match. Expected: 5, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Targetname[33],EntID,InternalName[64]
	get_string(1,Targetname,32)
	EntID = get_param(2)
	get_string(3,InternalName,63)
	
	if(UTIL_ARP_GetProperty(Targetname,EntID) != -1)
	{
		format(g_Query,4095,"Door already exists: %s/%d",Targetname,EntID)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(UTIL_ARP_MatchProperty(InternalName) == -1)
	{
		format(g_Query,4095,"Property does not exist: %s",InternalName)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new CurArray = array_create()
	array_set_int(g_DoorArray,g_DoorNum++,CurArray)
	
	array_set_string(CurArray,0,Targetname)
	array_set_int(CurArray,1,EntID)
	array_set_string(CurArray,2,InternalName)
	array_set_int(CurArray,3,1)
	
	return g_DoorNum
}

public _ARP_DeleteDoor(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Door = get_param(1) - 1
	if(UTIL_ARP_ValidDoor(Door))
		return UTIL_ARP_DeleteDoor(Door)
	
	return FAILED
}

UTIL_ARP_DeleteDoor(Door)
{
	new Targetname[33],InternalName[64],CurArray,NextArray,DoorArray = array_get_int(g_DoorArray,Door)
	for(new Count = Door;Count < g_DoorNum - 1;Count++)
	{
		NextArray = array_get_int(g_DoorArray,Count + 1)
		array_get_string(NextArray,0,Targetname,32)
		array_get_string(NextArray,2,InternalName,63)
		CurArray = array_get_int(g_DoorArray,Count)
		array_set_string(CurArray,0,Targetname)
		array_set_int(CurArray,1,array_get_int(NextArray,1))
		array_set_string(CurArray,2,InternalName)
		array_set_int(CurArray,3,array_get_int(NextArray,3))
		
		array_set_int(g_DoorArray,Count,NextArray)
	}
	
	array_destroy(DoorArray)
	array_delete(g_DoorArray,--g_DoorNum)
	
	new Quoted[130]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),InternalName)
	
	format(g_Query,4095,"DELETE FROM %s WHERE internalname='%s'",g_DoorsTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	return SUCCEEDED
}

public _ARP_ValidProperty(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_ValidProperty(get_param(1) - 1)
}

public _ARP_ValidDoor(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_ValidDoor(get_param(1) - 1)
}

public _ARP_ValidPropertyName(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new InternalName[64]
	get_string(1,InternalName,63)
	
	if(UTIL_ARP_MatchProperty(InternalName) > -1)
		return SUCCEEDED
	
	return FAILED
}
	
public _ARP_ValidDoorName(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	new Ent = get_param(2),Targetname[33]
	get_string(1,Targetname,32)
	
	if(UTIL_ARP_GetProperty(Targetname,Ent) > -1)
		return SUCCEEDED
	
	return FAILED
}

public _ARP_PropertyNum()
	return g_PropertyNum

public _ARP_DoorNum()
	return g_DoorNum

public _ARP_PropertyMatch(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Targetname[33],EntID = get_param(2),InternalName[64]
	get_string(1,Targetname,32)
	get_string(3,InternalName,63)
	
	if(Targetname[0] || EntID)
		return UTIL_ARP_GetProperty(Targetname,EntID) + 1
		
	return UTIL_ARP_MatchProperty(InternalName) + 1
}

public _ARP_DoorMatch(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Targetname[33],EntID = get_param(2)
	get_string(1,Targetname,32)
	
	if(Targetname[0] || EntID)
		return UTIL_ARP_GetDoor(Targetname,EntID) + 1
		
	return FAILED
}

public _ARP_PropertySetExternalName(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,ExternalName[64]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	get_string(2,ExternalName,63)
	array_set_string(array_get_int(g_PropertyArray,Property),1,ExternalName)
	
	UTIL_ARP_PropertyChanged(Property)
	
	return SUCCEEDED
}

public _ARP_PropertyGetExternalName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,ExternalName[64]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	array_get_string(array_get_int(g_PropertyArray,Property),1,ExternalName,63)
	set_string(2,ExternalName,get_param(3))
	
	return SUCCEEDED
}

public _ARP_PropertyGetInternalName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,InternalName[64]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	array_get_string(array_get_int(g_PropertyArray,Property),0,InternalName,63)
	set_string(2,InternalName,get_param(3))
	
	return SUCCEEDED
}

public _ARP_PropertySetOwnerName(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,OwnerName[33]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	get_string(2,OwnerName,32)
	array_set_string(array_get_int(g_PropertyArray,Property),2,OwnerName)
	
	return SUCCEEDED
}

public _ARP_PropertyGetOwnerName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,OwnerName[33]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	array_get_string(array_get_int(g_PropertyArray,Property),2,OwnerName,33)
	set_string(2,OwnerName,get_param(3))
	
	return SUCCEEDED
}

public _ARP_PropertySetOwnerAuth(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,OwnerAuth[36]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	// H9: the whole key of a character (35 characters on H9XASH), not the 32 stock ARP kept
	get_string(2,OwnerAuth,35)
	array_set_string(array_get_int(g_PropertyArray,Property),3,OwnerAuth)
	
	return SUCCEEDED
}

public _ARP_PropertyGetOwnerAuth(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,OwnerAuth[36]
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	// H9: the whole key, so that ARP_PropertyGetOwner (a player's key is 35 characters) finds the owner who is in the game
	array_get_string(array_get_int(g_PropertyArray,Property),3,OwnerAuth,35)
	set_string(2,OwnerAuth,get_param(3))
	
	return SUCCEEDED
}

public _ARP_PropertySetPrice(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	array_set_int(array_get_int(g_PropertyArray,Property),4,max(0,get_param(2)))
	
	return SUCCEEDED
}

public _ARP_PropertyGetPrice(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_PropertyArray,Property),4)
}

public _ARP_PropertySetLocked(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	array_set_int(array_get_int(g_PropertyArray,Property),5,get_param(2) ? 1 : 0)
	
	return SUCCEEDED
}

public _ARP_PropertyGetLocked(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_PropertyArray,Property),5)
}

public _ARP_PropertySetAccess(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	array_set_int(array_get_int(g_PropertyArray,Property),6,get_param(2))
	
	return SUCCEEDED
}

public _ARP_PropertyGetAccess(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_PropertyArray,Property),6)
}

public _ARP_PropertySetProfit(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	array_set_int(array_get_int(g_PropertyArray,Property),7,max(0,get_param(2)))
	
	return SUCCEEDED
}

public _ARP_PropertyGetProfit(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_PropertyArray,Property),7)
}

public _ARP_PropertyAddAccess(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,Authid[36],InternalName[64]
	get_string(2,Authid,35)
	
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	new CurArray = array_get_int(g_PropertyArray,Property)
	array_get_string(CurArray,0,InternalName,63)
	
	#if defined DEBUG
	g_TotalQueries++
	#endif
	
	ARP_SqlEscape(InternalName,63)
	
	new Quoted[72]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),Authid)
	
	format(g_Query,4095,"INSERT INTO %s VALUES('%s|%s')",g_KeysTable,Quoted,InternalName)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	new PlayerAuthid[36],Players[MAX_PLAYERS],Playersnum,Player
	get_players(Players,Playersnum)
	
	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		ArpKey(Player,PlayerAuthid,35)
		
		if(equali(Authid,PlayerAuthid))
		{
			H9_SetKey(CurArray,Player,1)
			break
		}
	}
	
	return SUCCEEDED
}

public _ARP_PropertyRemoveAccess(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1,Authid[36],InternalName[64]
	get_string(2,Authid,35)
	
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	new CurArray = array_get_int(g_PropertyArray,Property)
	array_get_string(CurArray,0,InternalName,63)
	
	#if defined DEBUG
	g_TotalQueries++
	#endif
	
	ARP_SqlEscape(InternalName,63)
	
	new Quoted[72]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),Authid)
	
	format(g_Query,4095,"DELETE FROM %s WHERE authidkey='%s|%s'",g_KeysTable,Quoted,InternalName)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	
	new PlayerAuthid[36],Players[MAX_PLAYERS],Playersnum,Player
	get_players(Players,Playersnum)
	
	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		ArpKey(Player,PlayerAuthid,35)
		
		if(equali(Authid,PlayerAuthid))
		{
			H9_SetKey(CurArray,Player,0)
			break
		}
	}
	
	return SUCCEEDED
}

public _ARP_PropertyClearAccess(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Property = get_param(1) - 1
	
	if(!UTIL_ARP_ValidProperty(Property))
	{
		format(g_Query,4095,"Property does not exist: %d",Property)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	UTIL_ARP_PropertyChanged(Property)
	
	return UTIL_ARP_PropertyClearAccess(Property)
}

UTIL_ARP_PropertyClearAccess(Property)
{
	new CurArray = array_get_int(g_PropertyArray,Property),InternalName[64]
	array_get_string(CurArray,0,InternalName,63)
	
	#if defined DEBUG
	g_TotalQueries++
	#endif
	
	ARP_SqlEscape(InternalName,63)
	
	if(H9_AnyKeys(CurArray))
	{
		format(g_Query,4095,"DELETE FROM %s WHERE authidkey LIKE '%%|%s'",g_KeysTable,InternalName)
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
		
		H9_ClearKeys(CurArray)
	}
	
	return SUCCEEDED
}

public _ARP_AddHudItem(Plugin,Params)
{
	if(Params < 4)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 4, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),Channel = get_param(2),Refresh = get_param(3)
	if(!is_user_connected(id) && id != -1)
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(Channel < 0 || Channel > HUD_NUM)
	{
		format(g_Query,4095,"Invalid channel: %d",Channel)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	vdformat(g_Query,4095,4,5)
	//while(replace(g_Query,4095,"^n","")) { }
	//add(g_Query,4095,"^n")

	if(g_HudPending)
		Refresh = 0
	
	UTIL_ARP_AddHudItem(id,Channel,g_Query,Refresh,HUDK_EXTRA)
	
	return SUCCEEDED
}

// H9: ARP_AddHudItem for a line of a given kind
public _ARP_AddHudItemKind(Plugin,Params)
{
	if(Params < 5)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 5, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	new id = get_param(1),Channel = get_param(2),Refresh = get_param(3),Kind = get_param(4)
	if(!is_user_connected(id) && id != -1)
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	if(Channel < 0 || Channel >= HUD_NUM)
	{
		format(g_Query,4095,"Invalid channel: %d",Channel)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	if(Kind < HUDK_EXTRA || Kind > HUDK_NEED)
		Kind = HUDK_EXTRA

	vdformat(g_Query,4095,5,6)

	if(g_HudPending)
		Refresh = 0

	UTIL_ARP_AddHudItem(id,Channel,g_Query,Refresh,Kind)

	return SUCCEEDED
}

public _ARP_SqlHandle(Plugin,Params)
	return _:g_SqlHandle

public _ARP_GetNpcClassname(Plugin,Params)
{
	if(Params != 2)	
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	set_string(1,g_NpcClassname,get_param(2))
	
	return SUCCEEDED
}

public _ARP_GetUserWallet(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))
		return g_Money[id]
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserWallet(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))
		return g_Money[id] = get_param(2)
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	return FAILED
}

public _ARP_GetUserBank(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))	
		return g_BankMoney[id]
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserBank(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))
		return g_BankMoney[id] = get_param(2)
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_GetUserHunger(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)

	if(is_user_connected(id))	
		return g_Hunger[id] / 10
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	return FAILED
}

public _ARP_SetUserHunger(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))
		return g_Hunger[id] = clamp(get_param(2),0,100) * 10
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_H9_TeamOf(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return H9_PlayerTeam(get_param(1))
}

public _ARP_H9_TeamName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Team = get_param(1)
	if(Team < ARP_H9_TEAM_FIRST || Team > ARP_H9_TEAMS)
		return 0
	
	return set_string(2,g_H9TeamNames[Team],get_param(3))
}

public _ARP_GetUserAccess(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(is_user_connected(id))
		return g_Access[id]
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserAccess(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),Access = get_param(2)
	if(is_user_connected(id))
	{
		g_Access[id] = Access
		g_Access[id] |= array_get_int(array_get_int(g_JobsArray,g_JobId[id]),3)
					
		g_AccessCache[id] = Access
	}
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return SUCCEEDED
}

public _ARP_GetJobsNum(Plugin,Params)
{
	// if it is anything other than 0
	if(Params)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 0, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return g_JobsNum
}

public _ARP_GetJobName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(1) - 1,Name[33]
	
	if(!UTIL_ARP_ValidJobId(JobId))
	{
		format(g_Query,4095,"Invalid job id: %d",JobId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	array_get_string(array_get_int(g_JobsArray,JobId),1,Name,32)
			
	set_string(2,Name,get_param(3))
	
	return SUCCEEDED
}

public _ARP_GetJobSalary(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(1) - 1
	
	if(!UTIL_ARP_ValidJobId(JobId))
	{
		format(g_Query,4095,"Invalid job id: %d",JobId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_JobsArray,JobId),2)
}

public _ARP_GetJobAccess(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(1) - 1
	
	if(!UTIL_ARP_ValidJobId(JobId))
	{
		format(g_Query,4095,"Invalid job id: %d",JobId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return array_get_int(array_get_int(g_JobsArray,JobId),3)
}
	
public _ARP_GetUserJobId(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	
	if(is_user_connected(id))
		return UTIL_ARP_ValidJobId(g_JobId[id]) ? g_JobId[id] + 1 : FAILED
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserJobId(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(2) - 1,id = get_param(1)
	
	if(!UTIL_ARP_ValidJobId(JobId))
	{
		format(g_Query,4095,"Invalid job id: %d",JobId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"User not connected: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	g_JobId[id] = JobId
	g_KeptJob[id][0] = 0
	g_Access[id] = g_AccessCache[id]
	
	g_Salary[id] = array_get_int(array_get_int(g_JobsArray,JobId),2)
	//g_Access[id] |= g_JobAccess[g_JobId[id]]
	g_Access[id] |= array_get_int(array_get_int(g_JobsArray,JobId),3)
	
	return SUCCEEDED
}

public _ARP_ValidJobId(Plugin,Params)
{
	if(Params != 1 && Plugin)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new JobId = get_param(1) - 1
	
	return UTIL_ARP_ValidJobId(JobId)
}

public _ARP_FindJobId(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	new SearchString[64],MaxResults = get_param(3),Num,Name[33]
	static Results[512],Temp[512],Length[512]
	get_string(1,SearchString,63)
	
	for(new Count;Count < g_JobsNum;Count++)
	{		
		if(!UTIL_ARP_ValidJobId(Count)) continue
		
		array_get_string(array_get_int(g_JobsArray,Count),1,Name,32)
		if(containi(Name,SearchString) != -1)
		{
			Temp[Num] = Count + 1
			Length[Num] = strlen(Name)
			
			Num++
		}
	}
	
	new CurStep,Cell = -1
	for(new Count,LowLength,Count2;Count < Num && Count < MaxResults;Count++)
	{
		LowLength = 9999999
		for(Count2 = 0;Count2 < Num;Count2++)
		{
			if(Length[Count2] < LowLength && Length[Count2] >= CurStep && Cell != Count2)
			{
				LowLength = Length[Count2]
				Cell = Count2
			}
		}
		
		CurStep = LowLength
		Results[Count] = Temp[Cell]
	}
	
	// H9: the caller's array holds MaxResults cells; Num counts every job that matched
	if(Num) set_array(2,Results,min(MaxResults,Num))
	
	return Num
}	

public _ARP_RegisterItem(Plugin,Params)
{
	if(Params != 4)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 4, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	// Hawk552: Disabled this for now, let's see how it goes.
	//if(!g_RegisterItem)
	//	return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,"ARP_RegisterItem can only be run in the ^"ARP_RegisterItems^" forward.",Plugin)
		
	new Name[33],Handler[33],Description[64]//,ItemId = get_param(2)
	get_string(1,Name,32)
	get_string(2,Handler,32)
	get_string(3,Description,63)
	
	//for(new Count;Count < MAX_ITEMS;Count++)
	//	if(equali(Name,g_ItemsNames[Count]) || ItemId == g_ItemsIds[Count])
	//		return FAILED
	
	new Len = strlen(Name)
	if(!Len)
	{
		format(g_Query,4095,"Name must have a length.",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new CheckName[33]
	for(new Count = 1;Count <= g_ItemsNum;Count++)
	{
		array_get_string(array_get_int(g_ItemsArray,Count),1,CheckName,32)
		if(equali(Name,CheckName))
		{
			format(g_Query,4095,"Item collision detected, name: %s",Name)
			return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
		}
	}
			
	new CurArray = array_create()
	
	array_set_int(g_ItemsArray,++g_ItemsNum,CurArray)
	array_set_string(CurArray,1,Name)
	array_set_int(CurArray,2,Plugin)
	array_set_string(CurArray,3,Handler)
	array_set_string(CurArray,4,Description)
	array_set_int(CurArray,5,get_param(4) ? 1 : 0)
	
	// this will start it at 1 externally, but 0 internally
	return g_ItemsNum
}

public _ARP_FindItemId(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	new Item[33],MaxResults = get_param(3),Num,Name[33]
	static Temp[512],Results[512],Length[512]
	get_string(1,Item,32)
	
	for(new Count = 1;Count <= g_ItemsNum && Num < 512;Count++)
	{
		array_get_string(array_get_int(g_ItemsArray,Count),1,Name,32)
		
		if(containi(Name,Item) != -1)
		{
			Temp[Num] = Count
			Length[Num] = strlen(Name)
			
			Num++
		}
	}
	
	new CurStep,Cell = -1
	for(new Count,LowLength,Count2;Count < Num && Count < MaxResults;Count++)
	{
		LowLength = 9999999
		for(Count2 = 0;Count2 < Num;Count2++)
		{
			if(Length[Count2] < LowLength && Length[Count2] >= CurStep && Cell != Count2)
			{
				LowLength = Length[Count2]
				Cell = Count2
			}
		}
		
		CurStep = LowLength
		Results[Count] = Temp[Cell]
	}
	
	if(Num) set_array(2,Results,min(MaxResults,Num))
	
	return Num
}

public _ARP_GetItemName(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	new ItemId = get_param(1),Name[33]
	/*for(new Count;Count < g_ItemsNum;Count++)
		if(g_ItemsIds[Count] == ItemId)
			return SUCCEEDED + set_string(2,g_ItemsNames[Count],get_param(3))*/
		
	UTIL_ARP_GetItemName(ItemId,Name,32)
	
	if(!Name[0])
	{
		format(g_Query,4095,"Invalid item id: %d",ItemId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	set_string(2,Name,get_param(3))
	
	return SUCCEEDED
}

public _ARP_RegisterNpc(Plugin,Params)
{
	if(Params != 7)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 7, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Float:Origin[3],Float:Angles[3],Model[64],Name[33],Handler[32],Zone,Property[64]
	
	get_string(1,Name,32)
	get_array_f(2,Origin,3)
	Angles[1] = get_param_f(3) - 180
	get_string(4,Model,63)
	get_string(5,Handler,31)
	Zone = get_param(6)
	get_string(7,Property,63)
	
	if(Zone)
	{
		new Ent = create_entity("info_target")
		if(!Ent)
		{
			format(g_Query,4095,"Unable to spawn NPC.",Params)
			return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
		}
		
		entity_set_string(Ent,EV_SZ_classname,g_NpcZoneClassname)
		entity_set_origin(Ent,Origin)
		entity_set_int(Ent,EV_INT_iuser3,Plugin)
		entity_set_string(Ent,EV_SZ_noise,Handler)
		entity_set_string(Ent,EV_SZ_noise1,Name)
		entity_set_string(Ent,EV_SZ_noise2,Property)
		
		return Ent
	}
	
	Origin[2] += 2.1
	
	if(PointContents(Origin) != CONTENTS_EMPTY)
		Origin[2] -= 2.1
	
	new Ent = create_entity("info_target")
	if(!is_valid_ent(Ent))
	{
		format(g_Query,4095,"Unable to spawn NPC.",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
	}
	
	entity_set_string(Ent,EV_SZ_classname,g_NpcClassname)
	//entity_set_model(Ent,Model)
	entity_set_model(Ent,Model)
	entity_set_origin(Ent,Origin)
	entity_set_size(Ent,Float:{-16.0,-16.0,-36.0},Float:{16.0,16.0,36.0})
	entity_set_int(Ent,EV_INT_solid,SOLID_BBOX)
	entity_set_byte(Ent,EV_BYTE_controller1,125)
	entity_set_byte(Ent,EV_BYTE_controller2,125)
	entity_set_byte(Ent,EV_BYTE_controller3,125)
	entity_set_byte(Ent,EV_BYTE_controller4,125)
	entity_set_int(Ent,EV_INT_sequence,1)
	entity_set_float(Ent,EV_FL_framerate,1.0)
	entity_set_vector(Ent,EV_VEC_angles,Angles)
	entity_set_int(Ent,EV_INT_iuser3,Plugin)
	entity_set_string(Ent,EV_SZ_noise,Handler)
	entity_set_string(Ent,EV_SZ_noise1,Name)
	entity_set_string(Ent,EV_SZ_noise2,Property)
	
	drop_to_floor(Ent)
	
	return Ent
}

public _ARP_IsNpc(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new Classname[33],Ent = get_param(1)
	if(!is_valid_ent(Ent))
	{
		format(g_Query,4095,"Invalid entity: %d",Ent)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	entity_get_string(Ent,EV_SZ_classname,Classname,32)
	
	if(equal(Classname,g_NpcClassname) || equal(Classname,g_NpcZoneClassname))
		return SUCCEEDED
	
	return FAILED
}

public _ARP_AddCommand(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new CurArray = array_create()
	
	array_set_int(g_CommandArray,++g_CommandNum,CurArray)
	
	get_string(1,g_Query,4095)
	array_set_string(CurArray,1,g_Query)
		
	get_string(2,g_Query,4095)
	array_set_string(CurArray,2,g_Query)
	
	return SUCCEEDED
}

/*public _ARP_GetUserItemId(Plugin,Params)
{
	if(Params != 2)
		return FAILED
		
	new id = get_param(1),Column = get_param(2)
	
	if(Column > g_UserItemNum[id] || !is_user_connected(id))
		return FAILED
		
	new Array =
	
	return array_isfilled(array_get_int(g_UserItemArray[id],Column),) 
}*/

public _ARP_GetUserItemNum(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
		
	new id = get_param(1),ItemId = get_param(2)
	
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(!UTIL_ARP_ValidItemId(ItemId))
	{
		format(g_Query,4095,"Invalid item id: %d",ItemId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_GetUserItemNum(id,ItemId)
}

public _ARP_GetUserItems(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(is_user_connected(id))
		return g_UserItemNum[id]
	else
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return FAILED
}

public _ARP_SetUserItemNum(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1),ItemId = get_param(2),ItemNum = get_param(3)/*,Cell = -1,Cache[2][MAX_USER_ITEMS]*/
	
	if(ItemNum < 0)
	{
		format(g_Query,4095,"Invalid item number, must be more than 0. Num: %d",ItemNum)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(!UTIL_ARP_ValidItemId(ItemId))
	{
		format(g_Query,4095,"Invalid item id: %d",ItemId)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	return UTIL_ARP_SetUserItemNum(id,ItemId,ItemNum)
	
	/*for(new Count;Count < MAX_USER_ITEMS;Count++)
		if(g_UserItemIds[id][Count] == ItemId)
		{
			Cell = Count
			break
		}
	
	if(Cell < 0)
		for(new Count;Count < MAX_USER_ITEMS;Count++)
			if(!g_UserItemIds[id][Count] || !g_UserItems[id][Count])
			{
				Cell = Count
				break
			}
	
	// if it's STILL less than 0
	if(Cell < 0)
	{
		log_amx("ERROR: User has max items!")
		return FAILED
	}
	
	g_UserItems[id][Cell] = Num
	g_UserItemIds[id][Cell] = ItemId
	
	Num = 0
	for(new Count;Count < MAX_USER_ITEMS;Count++)
		if(g_UserItems[id][Count] && g_UserItemIds[id][Count])
		{
			Cache[0][Num] = g_UserItems[id][Count]
			Cache[1][Num++] = g_UserItemIds[id][Count]
		}
	
	for(new Count;Count < MAX_USER_ITEMS;Count++)
		if(Count < Num)
		{
			g_UserItems[id][Count] = Cache[0][Count]
			g_UserItemIds[id][Count] = Cache[1][Count]
		}
		else
		{
			g_UserItems[id][Count] = 0
			g_UserItemIds[id][Count] = 0
		}
	
	return SUCCEEDED*/
}

// ---------------------------------------------------------------------------------------------------------------------- H9: popups for the chat lines
//
// Every Apollo RP plugin's client_print goes through arp_client_print (ApolloRP_Credits.inc), which gives a print_chat line that starts with [ARP] to ARP_H9Toast
// first. The popup is a notice of the H9 panels (h9vgui_notice: it holds, then fades, over the crosshair); the three latest are shown, the newest lowest. The state of
// the panels (h9vgui_supported) is this plugin's own, which is why the call comes here and not from the plugin that printed.
new g_ToastText[MAX_PLAYERS + 1][3][192]
new Float:g_ToastEnd[MAX_PLAYERS + 1][3]
new g_ToastWarn[MAX_PLAYERS + 1][3]

// whether the line is a refusal or a warning: shown in the warm colour
H9_ToastWarns(const Text[])
{
	new Words[][] = {"cannot","can't","do not","don't","not enough","refused","full","invalid","must","broken","no money"}
	for(new i;i < sizeof Words;i++)
		if(containi(Text,Words[i]) != -1)
			return 1

	return 0
}

// 0: not a popup, print the chat line; 1: a popup was sent, print nothing; 2: a popup was sent, and print the chat line too
H9_Toast(id,const Text[])
{
	new Mode = get_pcvar_num(p_Toast)
	if(!Mode || id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id) || !equal(Text,"[ARP] ",6))
		return 0

	if(!arpvgui_wanted(id) || !h9vgui_supported(id))
		return 0

	static Body[192],Panel[192]
	copy(Body,191,Text[6])
	new Len = strlen(Body)
	while(Len > 0 && (Body[Len - 1] == '^n' || Body[Len - 1] == ' '))
		Body[--Len] = 0
	if(!Len)
		return 0

	new Warn = H9_ToastWarns(Body)
	if(arp_credit_panel_text(id,Body,Panel,192))
		copy(Body,191,Panel)

	new Float:Now = get_gametime()
	for(new i = 2;i > 0;i--)
	{
		copy(g_ToastText[id][i],191,g_ToastText[id][i - 1])
		g_ToastEnd[id][i] = g_ToastEnd[id][i - 1]
		g_ToastWarn[id][i] = g_ToastWarn[id][i - 1]
	}
	copy(g_ToastText[id][0],191,Body)
	new Float:Hold = 4.0 + 0.03 * float(Len)
	if(Hold > 7.0)
		Hold = 7.0
	g_ToastEnd[id][0] = Now + Hold + 1.0
	g_ToastWarn[id][0] = Warn

	for(new i;i < 3;i++)
	{
		new Float:Left = g_ToastEnd[id][i] - Now - 1.0
		if(Left <= 0.0 || !g_ToastText[id][i][0])
			continue

		new Slot[16]
		formatex(Slot,15,"arptoast%d",i)
		h9vgui_notice(id,Slot,H9V_NOTICE_BANNER,g_ToastText[id][i],Left,1.0,g_ToastWarn[id][i] ? 255 : 225,g_ToastWarn[id][i] ? 200 : 225,g_ToastWarn[id][i] ? 120 : 255,-1.0,0.36 - 0.04 * float(i))
	}

	return Mode == 2 ? 2 : 1
}

public _ARP_H9Toast(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)

		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	static Text[512]
	get_string(2,Text,511)

	return H9_Toast(get_param(1),Text)
}

public _ARP_ItemDone(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	new id = get_param(1)
	if(!is_user_connected(id))
	{
		format(g_Query,4095,"User not connected: %d",id)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}
	
	if(g_ItemUse[id] == Plugin)
		g_ItemUse[id] = 0
		
	return SUCCEEDED
}

public _ARP_UserUseItem(Plugin,Params)
{
	if(Params != 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	return H9_UserUse(get_param(1),get_param(2),1)
}

public _ARP_UserGiveItem(Plugin,Params)
{
	if(Params != 4)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 4, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	return H9_UserGive(get_param(1),get_param(2),get_param(3),get_param(4),1)
}

public _ARP_UserDropItem(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	return H9_UserDrop(get_param(1),get_param(2),get_param(3),1)
}

public _ARP_UserShowItem(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	return H9_UserShow(get_param(1),get_param(2),get_param(3),1)
}

public _ARP_DropPack(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	new id = get_param(1)
	if(!is_user_connected(id))
		return 0

	return H9_MakePack(id,get_param(2),get_param(3))
}

public _ARP_GetItemInfo(Plugin,Params)
{
	if(Params != 6)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 6, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	new ItemId = get_param(1)
	if(!UTIL_ARP_ValidItemId(ItemId))
		return FAILED

	new Name[33],Description[64],CurArray = array_get_int(g_ItemsArray,ItemId)
	array_get_string(CurArray,1,Name,32)
	array_get_string(CurArray,4,Description,63)

	set_string(2,Name,get_param(3))
	set_string(4,Description,get_param(5))
	set_param_byref(6,array_get_int(CurArray,5))

	return SUCCEEDED
}

public _ARP_InvRoom(Plugin,Params)
{
	if(Params != 3)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 3, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	new ItemId = get_param(2),Qty = get_param(3)
	if(!UTIL_ARP_ValidItemId(ItemId))
		return Qty

	return H9_InvRoom(get_param(1),ItemId,Qty)
}

public _ARP_SaveUser(Plugin,Params)
{
	if(Params != 1)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 1, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,Plugin)
	}

	new id = get_param(1)
	if(!is_user_connected(id) || g_GotInfo[id] < STD_USER_QUERIES)
		return FAILED

	SaveUserData(id,0)

	return SUCCEEDED
}

public _ARP_ThrowError(Plugin,Params)
{
	if(Params < 2)
	{
		format(g_Query,4095,"Parameters do not match. Expected: 2 or more, Found: %d",Params)
		return UTIL_ARP_ThrowError(AMX_ERR_PARAMS,0,g_Query,Plugin)
	}
	
	get_string(2,g_Query,4095)
	new Mode = get_param(1)
	
	vformat(g_Query,4095,g_Query,3)
	
	UTIL_ARP_ThrowError(0,Mode,g_Query,Plugin)
	
	return SUCCEEDED
}
	
public client_putinserver(id)
{
	// H9: a retry comes back as id + MAX_PLAYERS (a player can be in any slot up to MAX_PLAYERS); the
	// player is loaded once his last save is done
	if(id > MAX_PLAYERS)
		id -= MAX_PLAYERS
	
	if(g_Saving[id])
	{
		set_task(0.5,"client_putinserver",id + MAX_PLAYERS)
		return
	}
	
	g_Joined[id] = false
	g_GotInfo[id] = 0
	for(new Hud;Hud < HUD_NUM;Hud++)
		g_HudCleared[id][Hud] = 0
	ArpHudForget(id)
	
	//g_Money[id] = 0
	//g_BankMoney[id] = 0
	
	g_ItemUse[id] = 0
	
	new Authid[36],Data[1],Results[1]
	// H9: ARP_FindJobId gives 1-based ids; g_JobId is 0-based
	if(ARP_FindJobId("Unemployed",Results,1)) g_JobId[id] = Results[0] - 1
	
	// H9: bots are not players of the roleplay: they share one auth id, so they are neither loaded
	// from the database nor saved to it; they are Unemployed, with nothing, for as long as they stay.
	if(is_user_bot(id))
	{
		g_Money[id] = 0
		g_BankMoney[id] = 0
		g_Hunger[id] = 0
		g_Access[id] = 0
		g_AccessCache[id] = 0
		g_JobRight[id] = 0
		g_Salary[id] = 0
		g_BadJob[id] = 0
		g_UserItemNum[id] = 0
		array_clear(g_UserItemArray[id])
		return
	}
	
	g_CharKey[id][0] = 0
	g_Acct[id] = 0
	g_AcctWait[id] = ArpCandidate(id) ? 0 : -1
	
	get_user_authid(id,Authid,35)
	Data[0] = id
	
	// H9: with arp_account_wait 0 his character is under his authid, as it was
	if(!get_pcvar_num(p_AcctWait))
	{
		copy(g_CharKey[id],35,Authid)
		LoadPlayer(id)
		return
	}
	
	// H9: his character's key first: the first authid recorded for his havoc9.org account, if his authid is one of its
	new Quoted[72]
	SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),Authid)
	
	format(g_Query,4095,"SELECT m2.authid FROM %s m1,%s m2 WHERE m1.authid='%s' AND m2.acct=m1.acct ORDER BY m2.id LIMIT 1",g_IdsTable,g_IdsTable,Quoted)
	UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"FetchClientKey",g_Query,Data,1)
}

public FetchClientData(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to SQL database.")
		return UTIL_ARP_ThrowError(0,1,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: consult developer.")
		return UTIL_ARP_ThrowError(0,1,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,1,g_Query,0)
	}
		
	new id = Data[0]
	
	// H9: a player whose game can prove a havoc9.org account and whom no row knows waits for it: the character he made
	// under an earlier authid may be his
	if(SQL_NumResults(Query) < 1 && g_AcctWait[id] >= 0)
	{
		set_task(1.0,"ArpRetry",id + MAX_PLAYERS * 2)
		return PLUGIN_CONTINUE
	}
	
	g_GotInfo[id]++
	
	// H9: his items and keys are read under the key of the character found
	ArpLoadExtras(id)
	
	if(SQL_NumResults(Query) < 1)
	{
		//g_FirstJoin[id] = 1

		new Quoted[72],StartMoney = get_pcvar_num(p_StartMoney)
		SQL_QuoteString(Empty_Handle,Quoted,charsmax(Quoted),g_CharKey[id])
		
		#if defined DEBUG
		g_TotalQueries++
		#endif
		
		format(g_Query,4095,"INSERT INTO %s VALUES('%s','%d','0','Unemployed','0','','')",g_UserTable,Quoted,StartMoney)
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
		
		new Results[1]
		ARP_FindJobId("Unemployed",Results,1)
		
		Results[0] -= 1
		
		// H9: a database without the job gets it here (UTIL_ARP_AddJob gives the 0-based id)
		if(!UTIL_ARP_ValidJobId(Results[0]))
			Results[0] = UTIL_ARP_AddJob("Unemployed",5,0)
		
		g_Money[id] = StartMoney
		g_Hunger[id] = 0
		g_BankMoney[id] = 0
		g_JobId[id] = Results[0]
		g_Access[id] = array_get_int(array_get_int(g_JobsArray,Results[0]),3)
		g_AccessCache[id] = 0
		g_JobRight[id] = 0
		g_Salary[id] = array_get_int(array_get_int(g_JobsArray,Results[0]),2)
		
		array_clear(g_UserItemArray[id])
		
		return PLUGIN_CONTINUE
	}
	
	// terrible way of doing it (like 2000 cells in total) but whatever
	new Temp[512]//,Exploded[MAX_USER_ITEMS][10],Left[5],Right[5]
	//SQL_ReadResult(Query,3,Temp,4095)
	
	g_BankMoney[id] = SQL_ReadResult(Query,1)
	g_Money[id] = SQL_ReadResult(Query,2)
	
	/*new Num = ExplodeString(Exploded,MAX_USER_ITEMS,Temp,9,' '),Array
	
	for(new Count;Count <= Num;Count++)
	{
		strtok(Exploded[Count],Left,4,Right,4,'|',1)
		
		Array = array_create()
		array_set_int(g_UserItemArray[id],++g_UserItemNum[id],Array)
		array_set_int(Array,1,str_to_num(Left))
		array_set_int(Array,2,str_to_num(Right))
	}*/
	
	new Results[2]
	SQL_ReadResult(Query,3,Temp,4095)
	g_KeptJob[id][0] = 0
	ARP_FindJobId(Temp,Results,2)
	
	g_JobId[id] = Results[0] - 1
	
	if(!Results[0])
	{
		g_BadJob[id] = 1
		copy(g_KeptJob[id],32,Temp)
		
		ARP_FindJobId("Unemployed",Results,1)
		if(!UTIL_ARP_ValidJobId(Results[0] - 1))
			Results[0] = UTIL_ARP_AddJob("Unemployed",5,0) + 1   // H9: + 1, the 1-based id
			
		g_JobId[id] = Results[0] - 1
		g_Salary[id] = 5
	}
	else if(UTIL_ARP_ValidJobId(g_JobId[id]))
		g_BadJob[id] = 0
	else
	{
		g_BadJob[id] = 1
		copy(g_KeptJob[id],32,Temp)
		
		ARP_FindJobId("Unemployed",Results,1)
		if(!UTIL_ARP_ValidJobId(Results[0] - 1))
			Results[0] = UTIL_ARP_AddJob("Unemployed",5,0) + 1   // H9: + 1, the 1-based id
			
		g_JobId[id] = Results[0] - 1
		g_Salary[id] = 5
	}
	
	g_Hunger[id] = SQL_ReadResult(Query,4)	
	SQL_ReadResult(Query,5,Temp,4095)
	g_Access[id] = ARP_AccessToInt(Temp)
	g_AccessCache[id] = g_Access[id]

	g_Salary[id] = array_get_int(array_get_int(g_JobsArray,g_JobId[id]),2)
	g_Access[id] |= array_get_int(array_get_int(g_JobsArray,g_JobId[id]),3)
		
	SQL_ReadResult(Query,6,Temp,4095)
	g_JobRight[id] = ARP_AccessToInt(Temp)
	
	CheckReady(id)
	
	return PLUGIN_CONTINUE
}

public FetchClientItems(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
		
	new id = Data[0],Temp[2][36],ItemId
	
	g_GotInfo[id]++
	
	array_clear(g_UserItemArray[id])
	
	while(SQL_MoreResults(Query))
	{
		SQL_ReadResult(Query,0,g_Query,4095)
		strtok(g_Query,Temp[0],35,Temp[1],35,'|',1)
		
		ItemId = UTIL_ARP_FindItemId(Temp[1])
		
		if(!UTIL_ARP_ValidItemId(ItemId))
		{			
			SQL_NextRow(Query)
			continue
		}
		
		array_set_int(g_UserItemArray[id],ItemId,-SQL_ReadResult(Query,1))
		
		SQL_NextRow(Query)
	}
	
	CheckReady(id)
	
	return PLUGIN_CONTINUE
}

public FetchClientKeys(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
		
	new id = Data[0],InternalName[33],Property,AuthidKey[96],Garbage[1]
	
	g_GotInfo[id]++
	while(SQL_MoreResults(Query))
	{
		SQL_ReadResult(Query,0,AuthidKey,95)
		strtok(AuthidKey,Garbage,0,InternalName,32,'|')
		
		Property = UTIL_ARP_MatchProperty(InternalName)
		if(Property != -1)		
			H9_SetKey(array_get_int(g_PropertyArray,Property),id,1)
		
		SQL_NextRow(Query)
	}
	
	CheckReady(id)
	
	return PLUGIN_CONTINUE
}

CheckReady(id)
	if(g_GotInfo[id] >= STD_USER_QUERIES)
	{
		new Data[1]
		Data[0] = id
		_CallEvent("Player_Ready",Data,1)
	}

/*
Handle:SqlConnect()
{
	static Errcode,Error[256]
	new Handle:SqlConnection = SQL_Connect(g_SqlHandle,Errcode,Error,255)
	
	if(SqlConnection == Empty_Handle)
	{
		log_amx(Error)
		g_SqlOk = false		
		
		return Handle:0
	}
	
	return SqlConnection
}
*/

public IgnoreHandle(FailState,Handle:Query,Error[],Errcode,Data[],DataSize) 
{
	if(FailState == TQUERY_CONNECT_FAILED)
	{
		format(g_Query,4095,"Could not connect to database: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	else if(FailState == TQUERY_QUERY_FAILED)
	{
		format(g_Query,4095,"Internal error: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	if(Errcode)
	{
		format(g_Query,4095,"Error on query: %s",Error)
		return UTIL_ARP_ThrowError(0,0,g_Query,0)
	}
	
	#if defined DEBUG
	g_TotalQueries--
	#endif
	
	return PLUGIN_CONTINUE
}

public ShowHud()
{		
	new StartTime = 600
		
	g_Time -= 10
	
	// Time is actually in like hundreds
	if(g_Time <= 0)
		g_Time = StartTime
	
	new Players[MAX_PLAYERS],Playersnum,Player/*,Pos*/,Retn,Fwd
		
	// H9: no bot is sent a HUD (nothing reads a bot's datagram)
	get_players(Players,Playersnum,"c")
	
	for(new Count,Count2;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		client_PreThink(Player)
		
		//for(Count2 = 0;Count2 < HUD_NUM;Count2++)
		//	ClearHud(Player,Count2)
		
		if(!is_user_connected(Player))
			continue
		
		// H9: once his havoc9.org account is proved, his authid is recorded with it
		if(!g_Acct[Player] && g_GotInfo[Player] >= STD_USER_QUERIES)
		{
			g_Acct[Player] = ArpAccount(Player)
			if(g_Acct[Player])
				ArpRecordId(Player)
		}
		
		if(g_Time == StartTime)
		{
			Fwd = CreateMultiForward("ARP_Salary",ET_STOP2,FP_CELL)
			if(Fwd < 0 || !ExecuteForward(Fwd,Retn,Player))
				continue
			
			if(!Retn)
				g_BankMoney[Player] += g_Salary[Player]
			
			DestroyForward(Fwd)
		}
		
		// H9: whether he is sent the HUD as a panel or as the text HUD
		ArpHudUpdate(Player)
		
		for(Count2 = 0;Count2 < HUD_NUM;Count2++)
			RenderHud(Player,Count2)
	}
	
	//DestroyForward(Forward)
	
	get_pcvar_string(p_Lights,g_Query,4095)
	set_lights(g_Query)
	
	set_task(2.0 - get_pcvar_float(p_Performance)/100.0,"ShowHud")
}

RenderHud(id,Hud)
{	
	g_HudPending = true
	
	static Temp[256]
	
	new Index,Body
	get_user_aiming(id,Index,Body,100)
	if(Hud != HUD_QUAT) 
		TravTrieClear(g_HudArray[id][Hud])
	
	new Data[2]
	Data[0] = id
	Data[1] = Hud
	if(_CallEvent("HUD_Render",Data,2))
		return
	
	g_Query[0] = 0
	
	g_PanelNum = 0
	
	// H9: a player who is shown the credit sign (ApolloRP_Credits.inc) is sent it in the panel's lines, as the single byte the panel draws; the text HUD
	// keeps "$" (the HUD font has no such glyph) and so does everything that parses a line
	new bool:Sign = g_HudPanel[id] && arp_credit_sign(id)
	
	new travTrieIter:Iter = GetTravTrieIterator(g_HudArray[id][Hud]),Kind,Ticker
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,Temp,255)
		ReadTravTrieCell(Iter,Kind)
		
		// H9: a line's value in the trie is its kind (HUDK_*); the panel is sent the lines apart, the text HUD the one text
		if(g_HudPanel[id] && g_PanelNum < HUDP_MAX_LINES)
		{
			g_PanelKind[g_PanelNum] = Kind
			copy(g_PanelText[g_PanelNum],HUDP_LINE_LEN - 1,Temp)
			if(Sign)
				arp_credit_convert(g_PanelText[g_PanelNum],HUDP_LINE_LEN,false)
			g_PanelNum++
		}
		
		Ticker += format(g_Query[Ticker],4095 - Ticker,"%s^n",Temp)
	}
	DestroyTravTrieIterator(Iter)
	
	if(Hud == HUD_QUAT)
		TravTrieClear(g_HudArray[id][Hud])
			
	g_HudPending = false
	
	// H9: a player whose game draws the panel is sent it, and no hudmessage
	if(g_HudPanel[id])
	{
		ArpHudSend(id,Hud)
		return
	}
	
	/*for(new Count,CurArray,Ticker;Count < g_HudNum[id][Hud];Count++)
	{
		CurArray = array_get_int(g_HudArray[id][Hud],Count)
		
		array_get_string(CurArray,0,Temp,255)
		Ticker += format(g_Query[Ticker],4095 - Ticker,Temp)
	}*/
	
	/*if(Hud == HUD_QUAT)
	{		
		TravTrieClear(g_HudArray[id][Hud])
		
		client_print(id,print_console,"g_LastMsg[id]: %s | g_Query: %s",g_LastMsg[id],g_Query)
		
		if(equali(g_LastMsg[id],g_Query))
			return
		
		client_print(id,print_console,"Passed.")
		
		set_hudmessage(get_pcvar_num(p_Hud[Hud][R]),get_pcvar_num(p_Hud[Hud][G]),get_pcvar_num(p_Hud[Hud][B]),get_pcvar_float(p_Hud[Hud][X]),get_pcvar_float(p_Hud[Hud][Y]),0,0.0,g_Query[0] ? 999999.9 : 1.0,g_Query[0] ? 0.3 : 0.0,g_Query[0] ? 0.0 : 0.3,-1)
		ShowSyncHudMsg(id,g_HudObjects[Hud],"%s",g_Query[0] ? g_Query : g_LastMsg[id])
	
		copy(g_LastMsg[id],127,g_Query)
	}
	else
	{
		set_hudmessage(get_pcvar_num(p_Hud[Hud][R]),get_pcvar_num(p_Hud[Hud][G]),get_pcvar_num(p_Hud[Hud][B]),get_pcvar_float(p_Hud[Hud][X]),get_pcvar_float(p_Hud[Hud][Y]),0,0.0,999999.9,0.0,0.0,-1)
		ShowSyncHudMsg(id,g_HudObjects[Hud],"%s",g_Query)
	}*/
	
	// H9: a HUD with nothing to show is cleared once and not sent again until it has something, so
	// ARP holds only the HUD channels it is using and leaves the rest to every other HUD text
	if(!g_Query[0] && g_HudCleared[id][Hud])
		return
	g_HudCleared[id][Hud] = !g_Query[0]
	
	set_hudmessage(get_pcvar_num(p_Hud[Hud][R]),get_pcvar_num(p_Hud[Hud][G]),get_pcvar_num(p_Hud[Hud][B]),get_pcvar_float(p_Hud[Hud][X]),get_pcvar_float(p_Hud[Hud][Y]),0,0.0,999999.9,0.0,0.0,-1)
	ShowSyncHudMsg(id,g_HudObjects[Hud],"%s",g_Query)
}

// H9: why a player is, or is not, sent the HUD as a panel: HUDWHY_PANEL when he is, else the first thing that says no
ArpHudWhy(id)
{
	if(!get_pcvar_num(p_HudPanel))
		return HUDWHY_SERVER
	
	if(g_HudMsg <= 0)
		return HUDWHY_NOMSG
	
	if(!h9vgui_supported(id))
		return HUDWHY_NOVGUI
	
	new Value[8]
	get_user_info(id,"_h9arphud",Value,7)
	if(!Value[0])
		return HUDWHY_NOKEY
	
	return str_to_num(Value) >= 1 ? HUDWHY_PANEL : HUDWHY_OFF
}
	
// H9: once a pass of ShowHud, for each human player: decides which HUD he is sent, and moves him from one to the other
ArpHudUpdate(id)
{
	new Why = ArpHudWhy(id)
	if(Why != g_HudWhy[id])
	{
		new Name[32]
		get_user_name(id,Name,31)
		log_amx("[ARP] HUD: %s is sent %s: %s",Name,Why == HUDWHY_PANEL ? "the HUD panel" : "the text HUD",g_HudWhyText[Why])
		g_HudWhy[id] = Why
	}
	
	new Panel = Why == HUDWHY_PANEL ? 1 : 0
	if(Panel == g_HudPanel[id])
		return
	
	g_HudPanel[id] = Panel
	ArpHudReset(id)
	
	if(Panel)
		ArpHudClearText(id)
	else
		ArpHudPanelDown(id)
}
	
// H9: what was sent to a player is forgotten, so the next pass sends every HUD whole
ArpHudReset(id)
{
	for(new Hud;Hud < HUD_NUM;Hud++)
	{
		g_HudSig[id][Hud] = 0
		g_HudSentAt[id][Hud] = 0.0
		g_HudLast[id][Hud][0] = 0
	}
}
	
// H9: a player joins or leaves: he is sent the text HUD until his game says otherwise
ArpHudForget(id)
{
	g_HudPanel[id] = 0
	g_HudWhy[id] = -1
	g_HudSentMsgs[id] = 0
	g_HudFirstLogged[id] = 0
	ArpHudReset(id)
}
	
// H9: the hudmessages of a player who is now sent the panel are taken down, each HUD's channel with an empty text
ArpHudClearText(id)
{
	for(new Hud;Hud < HUD_NUM;Hud++)
	{
		set_hudmessage(get_pcvar_num(p_Hud[Hud][R]),get_pcvar_num(p_Hud[Hud][G]),get_pcvar_num(p_Hud[Hud][B]),get_pcvar_float(p_Hud[Hud][X]),get_pcvar_float(p_Hud[Hud][Y]),0,0.0,999999.9,0.0,0.0,-1)
		ShowSyncHudMsg(id,g_HudObjects[Hud],"%s","")
		g_HudCleared[id][Hud] = 1
	}
}
	
// H9: the panels of a player who is now sent the text HUD are taken down
ArpHudPanelDown(id)
{
	if(g_HudMsg <= 0 || !is_user_connected(id) || is_user_bot(id))
		return
	
	ArpHudBegin(id,HUDP_OP_CLEAR_ALL)
	message_end()
	
	for(new Hud;Hud < HUD_NUM;Hud++)
		g_HudCleared[id][Hud] = 0
}
	
// H9: opens an H9ArpHud message to one player. It is reliable: an unreliable message travels in the same datagram as the
// entities, which a big map fills, and a datagram that does not fit is dropped whole.
ArpHudBegin(id,Op)
{
	engfunc(EngFunc_MessageBegin,MSG_ONE,g_HudMsg,Float:{0.0,0.0,0.0},id)
	write_byte(Op)
	g_HudSentMsgs[id]++
}
	
// H9: a HUD's place on the screen as the arp_hudN_x and _y say, in thousandths; -1 is centred
ArpHudCoord(Pcvar)
{
	new Float:Value = get_pcvar_float(Pcvar)
	return Value < 0.0 ? -1 : clamp(floatround(Value * 1000.0),0,1000)
}
	
ArpHudHash(Hash,Kind,Text[])
{
	Hash = Hash * 31 + Kind + 1
	for(new Count;Text[Count];Count++)
		Hash = Hash * 31 + Text[Count]
	
	return Hash
}
	
// H9: sends the lines RenderHud has gathered in g_PanelText and g_PanelKind (g_PanelNum of them) as the panel of one HUD, when they
// are not what he already has, or when it is time to say them again (arp_hud_refresh; the notice's gap).
//   op 1   byte op, byte hud, byte number of the content, byte part (bits 0 to 3) with bit 7 on the last one, byte lines,
//          then in part 0 only: short x and y in thousandths; then each line: byte kind, string text.
//   op 2   byte op, byte hud: the HUD is taken down.
//   op 3   byte op: every HUD is taken down.
// A HUD that does not fit in one message is sent as parts of one content. Nothing the game holds changes until the last one has
// come, so a part that was lost leaves it what it had.
ArpHudSend(id,Hud)
{
	new Float:Now = get_gametime()
	new Num = g_PanelNum
	
	if(!Num)
	{
		// the notice takes itself down on his screen; any other HUD that was up is taken down once
		if(Hud != HUD_QUAT && g_HudSig[id][Hud])
		{
			ArpHudBegin(id,HUDP_OP_CLEAR)
			write_byte(Hud)
			message_end()
	
			g_HudSig[id][Hud] = 0
			g_HudSentAt[id][Hud] = Now
			g_HudLast[id][Hud][0] = 0
		}
		return
	}
	
	new Px = ArpHudCoord(p_Hud[Hud][X]),Py = ArpHudCoord(p_Hud[Hud][Y])
	
	new Sig = Px * 1009 + Py + 7919
	for(new Count;Count < Num;Count++)
		Sig = ArpHudHash(Sig,g_PanelKind[Count],g_PanelText[Count])
	if(!Sig)
		Sig = 1
	
	new Float:Gap = Hud == HUD_QUAT ? HUDP_NOTICE_GAP : float(clamp(get_pcvar_num(p_HudRefresh),5,60))
	new Float:Age = Now - g_HudSentAt[id][Hud]
	if(Sig == g_HudSig[id][Hud] && Age >= 0.0 && Age < Gap)
		return
	
	new Gen = (g_HudGen[id][Hud] + 1) & 255
	g_HudGen[id][Hud] = Gen
	
	new Line,Part,Bytes
	while(Line < Num)
	{
		// as many lines as the message has room for, and at least one
		new Start = Line,Size = Part ? 5 : 9
		while(Line < Num)
		{
			new Cost = 2 + strlen(g_PanelText[Line])
			if(Line > Start && Size + Cost > HUDP_MSG_MAX)
				break
	
			Size += Cost
			Bytes += Cost - 2
			Line++
		}
	
		// a content has at most 16 parts: what does not fit in them is left out
		new bool:Last = Line >= Num || Part >= 15
		if(Last)
			Num = Line
	
		ArpHudBegin(id,HUDP_OP_CONTENT)
		write_byte(Hud)
		write_byte(Gen)
		write_byte(Part | (Last ? 128 : 0))
		write_byte(Line - Start)
		if(!Part)
		{
			write_short(Px)
			write_short(Py)
		}
		for(new Count = Start;Count < Line;Count++)
		{
			write_byte(g_PanelKind[Count])
			write_string(g_PanelText[Count])
		}
		message_end()
	
		Part++
	}
	
	g_HudSig[id][Hud] = Sig
	g_HudSentAt[id][Hud] = Now
	
	// what he was last sent, for arp_hudstate: the lines with a bar between them
	new Len
	g_HudLast[id][Hud][0] = 0
	for(new Count;Count < Num && Len < 94;Count++)
		Len += formatex(g_HudLast[id][Hud][Len],95 - Len,"%s%s",Count ? "|" : "",g_PanelText[Count])
	
	// H9: a console shows "$" (the credit sign is only for the panel)
	replace_all(g_HudLast[id][Hud],95,"^xA2;","$")
	
	if(!g_HudFirstLogged[id])
	{
		g_HudFirstLogged[id] = 1
	
		new Name[32]
		get_user_name(id,Name,31)
		log_amx("[ARP] HUD panel: first update sent to %s (HUD %d: %d line(s), %d byte(s) of text, %d message(s))",Name,Hud + 1,Num,Bytes,Part)
	}
}
	
// H9: arp_hudstate, from a console or the server's: who is sent the HUD panel and who the text HUD, why, and what was last sent
public CmdHudState(id,cid)
{
	if(!ARP_CmdAccess(id,cid,1))
		return PLUGIN_HANDLED
	
	console_print(id,"[ARP] HUD: arp_hud_panel %d (0 sends everyone the text HUD), arp_hud_refresh %d s, the H9ArpHud message is %s.",get_pcvar_num(p_HudPanel),clamp(get_pcvar_num(p_HudRefresh),5,60),g_HudMsg > 0 ? "registered" : "NOT registered")
	
	new Players[MAX_PLAYERS],Playersnum,Player,Name[32],Key[8],Why[96],Panels,Texts
	new Float:Now = get_gametime()
	get_players(Players,Playersnum)
	for(new Count;Count < Playersnum;Count++)
	{
		Player = Players[Count]
		get_user_name(Player,Name,31)
	
		if(is_user_bot(Player))
		{
			console_print(id,"#%d %s: a bot, sent no HUD.",Player,Name)
			continue
		}
	
		get_user_info(Player,"_h9arphud",Key,7)
		if(!Key[0])
			copy(Key,7,"missing")
	
		if(g_HudWhy[Player] < 0)
			copy(Why,95,"not decided yet")
		else
			copy(Why,95,g_HudWhyText[g_HudWhy[Player]])
	
		if(g_HudPanel[Player])
			Panels++
		else
			Texts++
	
		console_print(id,"#%d %s: %s (%s); userinfo _h9arphud is %s; %d panel message(s) sent.",Player,Name,g_HudPanel[Player] ? "PANEL" : "TEXT HUD",Why,Key,g_HudSentMsgs[Player])
	
		if(!g_HudPanel[Player])
			continue
	
		for(new Hud;Hud < HUD_NUM;Hud++)
		{
			if(g_HudSentAt[Player][Hud] <= 0.0)
				console_print(id,"      HUD %d: nothing sent.",Hud + 1)
			else if(!g_HudSig[Player][Hud])
				console_print(id,"      HUD %d: taken down %.1f s ago.",Hud + 1,Now - g_HudSentAt[Player][Hud])
			else
				console_print(id,"      HUD %d: sent %.1f s ago: %s",Hud + 1,Now - g_HudSentAt[Player][Hud],g_HudLast[Player][Hud])
		}
	}
	
	console_print(id,"[ARP] HUD: %d player(s) sent the panel, %d the text HUD.",Panels,Texts)
	
	return PLUGIN_HANDLED
}
	

/*ClearHud(id,Hud)
{
	for(new Count,CurArray;Count < g_HudNum[id][Hud];Count++)
	{
		CurArray = array_get_int(g_HudArray[id][Hud],Count)
		array_destroy(CurArray)
	}
	
	g_HudNum[id][Hud] = 0
	
	TravTrieClear(g_HudArray[id][Hud])
	
	new travTrieIter:Iter = GetTravTrieIterator(g_HudArray[id]),Channel = -1
	while(MoreTravTrie(Iter))
	{
		ReadTravTrieKey(Iter,g_Query,4095)
		ReadTravTrieCell(Iter,Channel)
		
		if(Channel == Hud)
			TravTrieDeleteKey(g_HudArray[id],g_Query)
		
		Channel = -1
	}
	DestroyTravTrieIterator(Iter)
}*/

public ForwardSetClientMaxspeed(id,Float:NewSpeed)
{
	g_MaxSpeed[id] = NewSpeed
	return FMRES_IGNORED
}

public EventDeathMsg()
{
	new id = read_data(2)
	if(get_pcvar_num(p_WalletDeath))
		g_Money[id] = 0
	
	g_Hunger[id] = 0
}

public EventResetHUD(id)
	set_task(1.0,"Welcome",id)

public Welcome(id)
	if(is_user_alive(id))
	{		
		if(!g_Joined[id])
		{
			for(new Count;Count < 3;Count++)
			{
				get_pcvar_string(p_Welcome[Count],g_Query,4095)
				if(g_Query[0])
					client_print(id,print_chat,"[ARP] %s",g_Query)
			}
			
			new Authid[36]
			get_user_authid(id,Authid,35)
			if(containi(Authid,"PENDING") != -1 || containi(Authid,"LAN") != -1 || equali(Authid,"STEAM_0:0"))
				client_print(id,print_chat,"[ARP] Your Steam identification has failed to load. Your user data will not be saved.")
			
			g_Joined[id] = true
		}
		
		if(g_BadJob[id])
		{
			if(g_KeptJob[id][0])
			{
				client_print(id,print_chat,"[ARP] Your job (%s) is not offered on this map. You are Unemployed here; it is kept for where it is offered.",g_KeptJob[id])
			}
			else
			{
				client_print(id,print_chat,"[ARP] Notice: Your job no longer exists. Please contact an administrator.")
				client_print(id,print_chat,"[ARP] You have been temporarily set back to Unemployed.")
			}
			
			g_BadJob[id] = 0
		}
		
		if(g_SqlHandle == Empty_Handle)
		{
			client_print(id,print_chat,"[ARP] The server is currently malfunctioning and will not save any data.")
			client_print(id,print_chat,"[ARP] Please inform the administration of this problem and be patient while they solve it.")
		}
	}
	
public CmdJobList(id)
{
	new Arg[33]
	read_argv(1,Arg,32)
	
	new Start = str_to_num(Arg),Items = get_pcvar_num(p_ItemsPerPage),Num,Access[JOB_ACCESSES + 1],Name[33],Data[2]
	Data[0] = id
	Data[1] = Start
	
	if(_CallEvent("Job_List",Data,2))
		return PLUGIN_HANDLED
	
	if(Start >= g_JobsNum || Start < 0)
	{
		client_print(id,print_console,"No jobs to display at this area.")
		return PLUGIN_HANDLED
	}
	
	client_print(id,print_console,"ARP Jobs List (Starting at #%d)",Start)
	client_print(id,print_console,"NUMBER   JOBID   NAME   SALARY   ACCESS")
	
	for(new Count = Start;Count < Start + Items;Count++)
	{
		if(Count >= g_JobsNum)
			break
		
		if(!UTIL_ARP_ValidJobId(Count))
			continue
		
		ARP_IntToAccess(array_get_int(array_get_int(g_JobsArray,Count),3),Access,JOB_ACCESSES)
		array_get_string(array_get_int(g_JobsArray,Count),1,Name,32)
		
		client_print(id,print_console,"#%d   %d   %s   $%d   %s",++Num,Count + 1,Name,array_get_int(array_get_int(g_JobsArray,Count),2),Access)
	}
	
	if(Start + Items < g_JobsNum)
		client_print(id,print_console,"Type ^"arp_joblist %d^" to view next jobs.",Start + Items)
	
	return PLUGIN_HANDLED
}

public CmdItemList(id)
{
	new Arg[33]
	read_argv(1,Arg,32)
	
	new Start = str_to_num(Arg) + 1,Items = get_pcvar_num(p_ItemsPerPage),Data[2]
	Data[0] = id
	Data[1] = Start
	
	if(_CallEvent("Item_List",Data,2))
		return PLUGIN_HANDLED
	
	if(Start > g_ItemsNum || Start < 1)
	{
		client_print(id,print_console,"No jobs to display at this area.")
		return PLUGIN_HANDLED
	}
	
	client_print(id,print_console,"ARP Items List (Starting at #%d)",Start)
	client_print(id,print_console,"NUMBER   ITEMID   NAME   DISPOSABLE   DESCRIPTION")
	
	new Name[33],Description[64],CurArray
	
	for(new Count = Start;Count < Start + Items;Count++)
	{
		if(Count > g_ItemsNum)
			break
		
		CurArray = array_get_int(g_ItemsArray,Count)
		
		array_get_string(CurArray,1,Name,32)
		array_get_string(CurArray,4,Description,63)
		
		client_print(id,print_console,"#%d   %s   %s   %s",Count,Name,array_get_int(CurArray,5) ? "Yes" : "No",Description)
	}
	
	if(Start + Items <= g_ItemsNum)
		client_print(id,print_console,"Type ^"arp_itemlist %d^" to view next items.",Start + Items - 1)
	
	return PLUGIN_HANDLED
}

ItemUse(id,ItemId,UseUp)
{
	new Handler[33],Plugin = array_get_int(array_get_int(g_ItemsArray,ItemId),2)
	array_get_string(array_get_int(g_ItemsArray,ItemId),3,Handler,32)
	
	new Forward = CreateOneForward(Plugin,Handler,FP_CELL,FP_CELL),Return
	if(Forward < 0)
	{
		format(g_Query,4095,"Function ^"%s^" does not exist in plugin %d.",Handler,Plugin)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
	}
	
	// H9: the inventory knows which unit is in use until the item is used up: a handler may give it back (the food, the ammunition)
	H9_InvUse(id,ItemId,1)
	
	if(!ExecuteForward(Forward,Return,id,ItemId))
	{
		H9_InvUse(id,ItemId,0)
		format(g_Query,4095,"Function ^"%s^" does not exist in plugin %d.",Handler,Plugin)
		return UTIL_ARP_ThrowError(AMX_ERR_NATIVE,0,g_Query,0)
	}
	
	// if disposable
	if(UseUp && array_get_int(array_get_int(g_ItemsArray,ItemId),5))
		UTIL_ARP_SetUserItemNum(id,ItemId,UTIL_ARP_GetUserItemNum(id,ItemId) - 1)
	
	H9_InvUse(id,ItemId,0)
	
	DestroyForward(Forward)
	
	return SUCCEEDED
}

UTIL_ARP_PropertyChanged(Property)
	array_set_int(array_get_int(g_PropertyArray,Property),9,1)

UTIL_ARP_ValidProperty(Property)
{
	if(Property >= 0 && Property < g_PropertyNum)
		return SUCCEEDED
	
	return FAILED
}

UTIL_ARP_ValidDoor(Door)
{
	if(Door >= 0 && Door < g_DoorNum)
		return SUCCEEDED
	
	return FAILED
}

UTIL_ARP_GetProperty(Targetname[] = "",EntID = 0)
{
	static PropertyTargetname[33],InternalName[64]
	
	for(new Count;Count < g_DoorNum;Count++)
	{
		array_get_string(array_get_int(g_DoorArray,Count),0,PropertyTargetname,32)
		
		if((equali(PropertyTargetname,Targetname) && Targetname[0]) || (EntID && EntID == array_get_int(array_get_int(g_DoorArray,Count),1)))
		{
			array_get_string(array_get_int(g_DoorArray,Count),2,InternalName,63)
			return UTIL_ARP_MatchProperty(InternalName)
		}
	}
	
	return -1
}

UTIL_ARP_GetDoor(Targetname[] = "",EntID = 0)
{
	static PropertyTargetname[33]
	
	for(new Count;Count < g_DoorNum;Count++)
	{
		array_get_string(array_get_int(g_DoorArray,Count),0,PropertyTargetname,32)
		
		if((equali(PropertyTargetname,Targetname) && Targetname[0]) || (EntID && EntID == array_get_int(array_get_int(g_DoorArray,Count),1)))
			return Count
	}
	
	return FAILED
}

UTIL_ARP_MatchProperty(InternalName[])
{
	static CurName[64]
	
	for(new Count;Count < g_PropertyNum;Count++)
	{
		array_get_string(array_get_int(g_PropertyArray,Count),0,CurName,63)
		if(equali(CurName,InternalName))
			return Count
	}
	
	return -1
}

UTIL_ARP_FindItemId(ItemName[])
{
	new Name[33]
	for(new Count = 1;Count <= g_ItemsNum;Count++)
	{
		array_get_string(array_get_int(g_ItemsArray,Count),1,Name,32)
		
		if(equali(Name,ItemName))
			return Count
	}
	
	return -1
}

UTIL_ARP_SetUserItemNum(id,ItemId,Num)
{
	// H9: ARP_Inventory (when loaded) arranges the player's items in cells and answers the count to keep
	if(UTIL_ARP_ValidItemId(ItemId))
		Num = H9_InvCount(id,ItemId,Num)
	
	if(UTIL_ARP_ValidItemId(ItemId))
		Num ? array_set_int(g_UserItemArray[id],ItemId,Num) : array_delete(g_UserItemArray[id],ItemId)
	
	if(!Num)
	{		
		new Name[33],Key[36],Authid[72]
		UTIL_ARP_GetItemName(ItemId,Name,32)
		ARP_SqlEscape(Name,32)
		
		ArpKey(id,Key,35)
		SQL_QuoteString(Empty_Handle,Authid,charsmax(Authid),Key)
		
		#if defined DEBUG
		g_TotalQueries++
		#endif
		
		format(g_Query,4095,"DELETE FROM %s WHERE authidname='%s|%s'",g_ItemsTable,Authid,Name)
		UTIL_ARP_CleverQuery(g_Plugin,g_SqlHandle,"IgnoreHandle",g_Query)
	}
	
	return 1
}

UTIL_ARP_GetUserItemNum(id,ItemId)
	return array_isfilled(g_UserItemArray[id],ItemId) ? abs(array_get_int(g_UserItemArray[id],ItemId)) : 0
		

// H9: a count of a player's items is about to become Num. ARP_Inventory (when loaded) arranges the items in cells and answers the count to keep:
// what fits of an add (the rest is made a pack at his feet), and never below 0. Its answer is the count plus one, so that 0 is no answer.
H9_InvCount(id,ItemId,Num)
{
	if(g_H9FwdCount <= 0 || id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
		return Num

	new Old = UTIL_ARP_GetUserItemNum(id,ItemId)
	if(Num == Old)
		return Num

	new Return
	if(!ExecuteForward(g_H9FwdCount,Return,id,ItemId,Old,Num) || Return < 1)
		return Num

	return Return - 1
}

// H9: how many of Qty of an item the player's inventory has room for: all of it unless ARP_Inventory (when loaded) says less
H9_InvRoom(id,ItemId,Qty)
{
	if(g_H9FwdRoom <= 0 || Qty < 1 || id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
		return Qty

	new Return
	if(!ExecuteForward(g_H9FwdRoom,Return,id,ItemId,Qty) || Return < 1)
		return Qty

	return min(Return - 1,Qty)
}

// H9: an item of the player's is being used: begin 1 before its handler runs, 0 after the item is used up
H9_InvUse(id,ItemId,Begin)
{
	if(g_H9FwdUse <= 0 || id < 1 || id > MAX_PLAYERS)
		return

	new Return
	ExecuteForward(g_H9FwdUse,Return,id,ItemId,Begin)
}

// H9: a line for a player about his items: ARP_Inventory shows it in its window when that is open, and otherwise it is chat, "[ARP] <text>"
H9_Note(id,Level,const Text[])
{
	new Return
	if(g_H9FwdNote > 0 && ExecuteForward(g_H9FwdNote,Return,id,Level,Text) && Return)
		return

	client_print(id,print_chat,"[ARP] %s",Text)
}

UTIL_ARP_GetItemName(ItemId,ItemName[],Len)
{
	if(!UTIL_ARP_ValidItemId(ItemId))
		return FAILED
	
	array_get_string(array_get_int(g_ItemsArray,ItemId),1,ItemName,Len)
	
	/*new Array
	for(new Count;Count < g_ItemsNum;Count++)
	{
		Array = array_get_int(g_ItemsArray,Count + 1)
		
		if(ItemId == array_get_int(Array,2))
		{
			array_get_string(Array,1,ItemName,Len)
			return SUCCEEDED
		}
	}*/
	
	//return FAILED
	
	return SUCCEEDED
}

UTIL_ARP_ValidItemId(ItemId)
{
	if(ItemId <= g_ItemsNum && ItemId > 0)
		return SUCCEEDED
	
	return FAILED
}

UTIL_ARP_ValidJobId(JobId)
{
	if(JobId < g_JobsNum && JobId >= 0 && array_get_int(g_JobsArray,JobId) != -1)
		return SUCCEEDED
	
	return FAILED
}

UTIL_ARP_ThrowError(Error,Fatal,Message[],Plugin)
{	
	if(Plugin)
	{
		new Name[64],Filename[64],Temp[2]
	
		get_plugin(Plugin,Filename,63,Name,63,Temp,1,Temp,1,Temp,1)
		
		if(Error)
			log_error(Error,"[ARP] [PLUGIN: %s - %s] %s",Name,Filename,Message)
		else
			log_amx("[ARP] [PLUGIN: %s - %s] %s",Name,Filename,Message)
	}
	else
		if(Error)
			log_error(Error,"[ARP] [PLUGIN: CORE] %s",Message)
		else
			log_amx("[ARP] [PLUGIN: CORE] %s",Message)
		
	if(Fatal)
	{
		new Forward = CreateMultiForward("ARP_Error",ET_IGNORE,FP_STRING),Return
		if(Forward < 0 || !ExecuteForward(Forward,Return,Message))
			return SUCCEEDED
		
		DestroyForward(Forward)
		
		pause("d")
	}
	
	return FAILED
}

UTIL_ARP_ClientPrint(id,Message[],{Float,Sql,Result,_}:...)
{
	vformat(g_Query,4095,Message,3)
	
	//if(equali(g_Query,g_LastMsg[id]))
	//	return
	
	new Copy[128]
	copy(Copy[2],125,Message)
	Copy[0] = id
	Copy[1] = HUD_QUAT
	
	switch(get_pcvar_num(p_AuxType))
	{
		case 1 :	
		{
			if(_CallEvent("HUD_AddItem",Copy,128)) return
			client_print(id,print_center,"%s",g_Query)
		}
		case 2 :
		{
			//ClearHud(id,HUD_QUAT)
			TravTrieClear(TravTrie:g_HudArray[id][HUD_QUAT])
			UTIL_ARP_AddHudItem(id,HUD_QUAT,g_Query,!g_HudPending,HUDK_EXTRA)
		}
	}
}

UTIL_ARP_AddHudItem(id,Channel,Message[],Refresh,Kind)
{
	new Copy[128]
	copy(Copy[2],125,Message)
	Copy[0] = id
	Copy[1] = Channel
	
	if(_CallEvent("HUD_AddItem",Copy,128)) return
	
	if(id == -1)
	{
		new Players[MAX_PLAYERS],Playersnum
		get_players(Players,Playersnum)
		for(new Count;Count < Playersnum;Count++)
			AddItem(Players[Count],Channel,Message,Refresh,Kind)
	}
	else
		AddItem(id,Channel,Message,Refresh,Kind)	
}

AddItem(id,Channel,Message[],Refresh,Kind)
{
	//new CurArray = array_create()
	//array_set_int(g_HudArray[id][Channel],g_HudNum[id][Channel]++,CurArray)
	
	//array_set_string(CurArray,0,Message)
	
	TravTrieSetCell(g_HudArray[id][Channel],Message,Kind)
	
	if(Refresh)
		RenderHud(id,Channel)
}

stock bool:fm_is_ent_visible(index, entity) 
{
    new Float:origin[3], Float:view_ofs[3], Float:eyespos[3]
    pev(index, pev_origin, origin)
    pev(index, pev_view_ofs, view_ofs)
    xs_vec_add(origin, view_ofs, eyespos)

    new Float:entpos[3]
    pev(entity, pev_origin, entpos)
    engfunc(EngFunc_TraceLine, eyespos, entpos, 0, index)

    switch (pev(entity, pev_solid)) {
        case SOLID_BBOX..SOLID_BSP: return global_get(glb_trace_ent) == entity
    }
    
    new Float:fraction
    global_get(glb_trace_fraction, fraction)
    if (fraction == 1.0)
        return true

    return false
}