#include <amxmodx>
#include <amxmisc>
#include <ApolloRP>
#include <engine>

new g_Soda
new g_Fries
new g_Milk
new g_Hotdog
new g_Pizza
new g_Hamburger
new g_Pasta
new g_Steak

new p_HungerEnabled
new p_ThirstEnabled
new p_ThirstKeep

new g_Thirst[MAX_PLAYERS + 1]	// 0 (quenched) to 100; kept in the database under the character's key once his row has been read (the kept thirst, below), and a death starts it again at 0

new g_ThirstKey[MAX_PLAYERS + 1][36]	// the key his row is kept under, as it was when he loaded ("": nothing is read or written for him)
new g_ThirstKnown[MAX_PLAYERS + 1]	// 0: his row has not been read, and his thirst is in memory alone; 1: it has been asked for; 2: it has been read (or he has none), and g_Thirst is what is written
new g_ThirstSeq[MAX_PLAYERS + 1]	// the count of his joins, so that the answer to an old read is ignored
new g_ThirstTable[64]	// the name of the table (thirst_table_name)
new g_ThirstMade	// the table is there
new Float:g_ThirstFailUntil	// after a query failed nothing is tried before this game time

#define THIRST_BACKOFF 60.0	// seconds nothing is tried again after the database failed

#define THIRST_SQL_TABLE_SQLITE "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),thirst INT(11),UNIQUE (authid))"
#define THIRST_SQL_TABLE_MYSQL  "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),thirst INT(11),UNIQUE KEY (authid))"
#define THIRST_SQL_READ         "SELECT thirst FROM %s WHERE authid='%s'"
#define THIRST_SQL_PUT_SQLITE   "INSERT OR REPLACE INTO %s (authid,thirst) VALUES ('%s',%d)"
#define THIRST_SQL_PUT_MYSQL    "REPLACE INTO %s (authid,thirst) VALUES ('%s',%d)"

new g_Starving[MAX_PLAYERS + 1]
new g_Eating[MAX_PLAYERS + 1]

public ARP_Init()
{
	ARP_RegisterPlugin("Hunger Mod",ARP_VERSION,"The Apollo RP Team","Creates hunger-related items and settings")
	
	p_HungerEnabled = register_cvar("arp_hunger_enabled","1")
	p_ThirstEnabled = register_cvar("arp_thirst_enabled","1")
	
	// 1: a character's thirst is kept in the database, as his hunger is, and comes back when he joins again; 0: thirst is in memory alone, and a player who joins starts at 0
	p_ThirstKeep = register_cvar("arp_h9_thirst_keep","1")
	
	ARP_RegisterEvent("HUD_Render","EventHudRender")
	ARP_RegisterEvent("Player_Ready","EventPlayerReady")
	ARP_RegisterEvent("Player_Save","EventPlayerSave")
	
	set_task(15.0,"SetHunger",_,_,_,"b")
	set_task(1.0,"CheckHunger",_,_,_,"b")
	set_task(15.0,"SetThirst",_,_,_,"b")
}

public plugin_init() register_event("DeathMsg","EventDeathMsg","a")

public CheckHunger()
{
	if(!get_pcvar_num(p_HungerEnabled)) return
	
	new Players[MAX_PLAYERS],Playersnum,id,Hunger
	get_players(Players,Playersnum)
	
	for(new Count;Count < Playersnum;Count++)
	{
		id = Players[Count]
		if(!is_user_alive(id)) continue
		
		Hunger = ARP_GetUserHunger(id)
		
		if(!g_Starving[id] && Hunger >= 75)
		{					
			client_print(id,print_chat,"[ARP] You are starting to get very hungry.")
			g_Starving[id] = 1
			ARP_SetUserSpeed(id,Speed_Mul,0.75)
		}
		else if(g_Starving[id] == 1 && Hunger >= 90)
		{
			client_print(id,print_chat,"[ARP] You are starving. You will no longer receive a salary until you eat.")
			g_Starving[id] = 2
		}
		else if(g_Starving[id] && Hunger < 90)
			g_Starving[id] = 1
		else if(g_Starving[id] && Hunger < 75)
		{
			ARP_SetUserSpeed(id,Speed_Mul,1.0/0.75)
			g_Starving[id] = 0
		}
	}
}

public SetHunger()
{
	if(!get_pcvar_num(p_HungerEnabled) || random_num(0,5)) return
	
	new Players[MAX_PLAYERS],Playersnum,id
	get_players(Players,Playersnum)
	
	for(new Count;Count < Playersnum;Count++)
	{
		id = Players[Count]
		if(!is_user_alive(id)) continue
		
		ARP_SetUserHunger(id,ARP_GetUserHunger(id) + 1)
	}
}

// Thirst is a second need beside hunger, and only a meter: it rises faster than hunger and only a drink quenches it; it changes nothing else.
// Switched by arp_thirst_enabled; kept in the database, as hunger is, while arp_h9_thirst_keep is 1 (the kept thirst, below).
public SetThirst()
{
	if(!get_pcvar_num(p_ThirstEnabled) || random_num(0,2)) return

	new Players[MAX_PLAYERS],Playersnum,id
	get_players(Players,Playersnum)

	for(new Count;Count < Playersnum;Count++)
	{
		id = Players[Count]

		// a player whose row could not be read is asked for it again
		if(!g_ThirstKnown[id] && g_ThirstKey[id][0]) thirst_ask(id)

		if(!is_user_alive(id)) continue

		if(g_Thirst[id] < 100) g_Thirst[id]++
	}
}

public client_putinserver(id)
{
	g_Thirst[id] = 0
	g_ThirstKey[id][0] = 0
	g_ThirstKnown[id] = 0
	g_ThirstSeq[id]++
}

public EventDeathMsg()
{
	new id = read_data(2)

	// a death quenches the thirst, as ARP_Core's own death handler feeds the hunger
	g_Thirst[id] = 0
	client_disconnect(id)
}

public client_disconnect(id)
	g_Starving[id] = g_Eating[id] = 0

public ARP_Salary(id)
{
	if(get_pcvar_num(p_HungerEnabled) && g_Starving[id] == 2) return PLUGIN_HANDLED
	
	return PLUGIN_CONTINUE
}

// The second HUD: a living player's hunger and thirst as needs (a bar each in an H9 player's panel at the top right, the text "Hunger: 42%" for
// every other player) and, from 90 of a need, a status line under them (Starving, Dehydrated). Nothing of a need that is off, or while the account
// is still loading, and no thirst while its row is being read.
public EventHudRender(Name[],Data[],Len)
{
	new id = Data[0]
	if(!is_user_alive(id) || Data[1] != HUD_SEC || ARP_SqlHandle() == Empty_Handle || !ARP_PlayerReady(id))
		return
	
	new Hungry = get_pcvar_num(p_HungerEnabled),Thirsty = get_pcvar_num(p_ThirstEnabled) && g_ThirstKnown[id] != 1
	
	if(Hungry) ARP_AddNeedItem(id,"Hunger",ARP_GetUserHunger(id))
	if(Thirsty) ARP_AddNeedItem(id,"Thirst",g_Thirst[id])
	
	if(Hungry && g_Starving[id] == 2) ARP_AddHudItemKind(id,HUD_SEC,0,HUDK_STATUS,"Starving")
	if(Thirsty && g_Thirst[id] >= 90) ARP_AddHudItemKind(id,HUD_SEC,0,HUDK_STATUS,"Dehydrated")
}

// ---------------------------------------------------------------------------------------------------------------------- the kept thirst
//
// Thirst is kept in the database, as hunger is, and comes back when the character joins again (arp_h9_thirst_keep 1, with arp_thirst_enabled 1; with either at 0 nothing below reads or writes anything,
// no table is made, and thirst is in memory alone: a player who joins starts at 0). Hunger is a column of ARP_Core's users table; thirst is a table of its own, arp_h9_thirst (authid, thirst), made with
// CREATE TABLE IF NOT EXISTS the first time it is needed, with one row for each character under the key ARP keeps his rows under (ARP_GetUserKey), so a rename, a rejoin and a second character on an
// account cannot swap two characters' thirst. A map whose own users table is not arp_users has a table named after that table (thirst_table_name), as the property tax names its tables. No row of any ARP
// table is added or changed, and going back is dropping the table.
//
//   READ   the character has loaded (ARP_Core's Player_Ready): his row is asked for. Thirst is what it holds, or 0 for a character that has none, as hunger is for a new character. Until the answer comes,
//          and for a player whose row cannot be asked for or read (the database is down, the table cannot be made, a statement fails, his key is none), thirst is in memory alone and nothing of it is
//          written; a player whose row could not be read is asked again at the next passes of SetThirst.
//   WRITE  ARP_Core saves the character (its Player_Save event: every arp_save_interval seconds, when he leaves, at a map change and when the server stops, which are the moments his hunger is written):
//          his thirst is written with it, by one statement under his key. Only for a player whose row has been read, so a thirst that was never read does not write over what the database holds.
//   DEATH  a death sets thirst to 0 in memory, as ARP_Core's death handler does hunger; the 0 is written at the next save.
//
// A statement is run by the core's worker, in order with the core's own: the row of a player who joins again is read after the row of his last save was written. A failed statement is said once in the log
// and the database is left alone for a minute.

// the key of a player's character, the one ARP keeps his rows under (ARP_GetUserKey: his authid, or the key of his havoc9.org account); none for a bot, a player who is not here and an authid ARP does not
// save a character under (pending, LAN, unknown)
stock thirst_key(id,key[],len)
{
	key[0] = 0

	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id))
		return

	new authid[36]
	get_user_authid(id,authid,35)
	ARP_GetUserKey(id,key,len)

	if(equal(key,authid) && (containi(key,"PENDING") != -1 || containi(key,"LAN") != -1 || equali(key,"STEAM_0:0") || containi(key,"UNKNOWN") != -1))
		key[0] = 0
}

// the name of the table, once: arp_h9_thirst, and for a map whose users table is not arp_users that table's letters, digits and underscores after it, so that characters a map's own users table keeps apart
// keep their thirst apart
stock thirst_table_name()
{
	new users[64]

	ARP_GetTable(USERS,users,63)
	copy(g_ThirstTable,63,"arp_h9_thirst")

	if(equali(users,"arp_users"))
		return

	new n = strlen(g_ThirstTable)
	g_ThirstTable[n++] = '_'

	for(new i;users[i] && n < 63;i++)
	{
		new c = users[i]
		if((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')
			g_ThirstTable[n++] = c
	}

	g_ThirstTable[n] = 0
}

// a failed query: said once in a while in the log, and the database is left alone for a time
stock thirst_db_fail(const what[],const why[])
{
	if(get_gametime() >= g_ThirstFailUntil)
		log_amx("[ARP] thirst: the database failed (%s: %s): thirst is not read or stored for now",what,why)

	g_ThirstFailUntil = get_gametime() + THIRST_BACKOFF
}

// whether the table is there (made once, here, with a query that waits: a few milliseconds, and the queries after it can rely on it)
stock bool:thirst_db_table()
{
	if(g_ThirstMade)
		return true

	thirst_table_name()

	new err,msg[128],Handle:db = SQL_Connect(ARP_SqlHandle(),err,msg,127)
	if(db == Empty_Handle || err)
	{
		thirst_db_fail("connect",msg)

		return false
	}

	new query[300]

	if(ARP_SqlMode() == MYSQL)
		formatex(query,299,THIRST_SQL_TABLE_MYSQL,g_ThirstTable)
	else
		formatex(query,299,THIRST_SQL_TABLE_SQLITE,g_ThirstTable)

	new Handle:st = SQL_PrepareQuery(db,"%s",query),bool:ok = SQL_Execute(st) ? true : false
	if(!ok)
		SQL_QueryError(st,msg,127)

	SQL_FreeHandle(st)
	SQL_FreeHandle(db)

	if(!ok)
	{
		thirst_db_fail("create",msg)

		return false
	}

	g_ThirstMade = 1

	return true
}

// whether thirst may be read and written now: it is on and kept, the database is up, nothing failed a moment ago, and the table is there
stock bool:thirst_db_ready()
{
	if(!get_pcvar_num(p_ThirstEnabled) || !get_pcvar_num(p_ThirstKeep) || get_gametime() < g_ThirstFailUntil || ARP_SqlHandle() == Empty_Handle)
		return false

	return thirst_db_table()
}

// the row of a player is asked for (thirst is what it holds, or 0 for a character that has none); the answer is ThirstDbRead
stock thirst_ask(id)
{
	if(!g_ThirstKey[id][0] || !thirst_db_ready())
		return

	new key[72],query[200],data[3]

	copy(key,71,g_ThirstKey[id])
	ARP_SqlEscape(key,71)
	formatex(query,199,THIRST_SQL_READ,g_ThirstTable,key)

	data[0] = id
	data[1] = get_user_userid(id)
	data[2] = g_ThirstSeq[id]

	g_ThirstKnown[id] = 1

	ARP_CleverQuery(ARP_SqlHandle(),"ThirstDbRead",query,data,3)
}

// the answer to the read of a row: his thirst is what it holds, unless he is gone (or another joined in his slot) meanwhile. A row that cannot be read leaves thirst in memory alone.
public ThirstDbRead(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused size,queuetime

	new id = data[0]

	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || get_user_userid(id) != data[1] || g_ThirstSeq[id] != data[2] || g_ThirstKnown[id] != 1)
		return PLUGIN_CONTINUE

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		g_ThirstKnown[id] = 0
		thirst_db_fail("read",error)

		return PLUGIN_CONTINUE
	}

	g_Thirst[id] = SQL_NumResults(query) > 0 ? clamp(SQL_ReadResult(query,0),0,100) : 0
	g_ThirstKnown[id] = 2

	return PLUGIN_CONTINUE
}

// his thirst is written under his key, once his row has been read: a character whose row was not read is never written, so what the database holds is not written over
stock thirst_save(id)
{
	if(id < 1 || id > MAX_PLAYERS || g_ThirstKnown[id] != 2 || !g_ThirstKey[id][0] || !thirst_db_ready())
		return

	new key[72],query[200]

	copy(key,71,g_ThirstKey[id])
	ARP_SqlEscape(key,71)

	if(ARP_SqlMode() == MYSQL)
		formatex(query,199,THIRST_SQL_PUT_MYSQL,g_ThirstTable,key,g_Thirst[id])
	else
		formatex(query,199,THIRST_SQL_PUT_SQLITE,g_ThirstTable,key,g_Thirst[id])

	ARP_CleverQuery(ARP_SqlHandle(),"ThirstDbDone",query)
}

// the answer to a write: a failed one is said once, and the next save writes the thirst again
public ThirstDbDone(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused query,data,size,queuetime

	if(failstate != TQUERY_SUCCESS || errnum)
		thirst_db_fail("write",error)

	return PLUGIN_CONTINUE
}

// the character has loaded (ARP_Core's Player_Ready): with thirst kept, his row is asked for, once in his stay in the game
public EventPlayerReady(Name[],Data[],Len)
{
	#pragma unused Name,Len

	new id = Data[0]

	if(id < 1 || id > MAX_PLAYERS || g_ThirstKnown[id] || !get_pcvar_num(p_ThirstEnabled) || !get_pcvar_num(p_ThirstKeep))
		return PLUGIN_CONTINUE

	thirst_key(id,g_ThirstKey[id],35)
	thirst_ask(id)

	return PLUGIN_CONTINUE
}

// ARP_Core saves the character (every arp_save_interval seconds, when he leaves, at a map change, when the server stops): his thirst is written with it
public EventPlayerSave(Name[],Data[],Len)
{
	#pragma unused Name,Len

	thirst_save(Data[0])

	return PLUGIN_CONTINUE
}

public ARP_RegisterItems()
{
	g_Soda = ARP_RegisterItem("Soda","_Food","A can of soda, heals 5 hunger and, with thirst on, 35 thirst.",1)
	g_Fries = ARP_RegisterItem("Fries","_Food","A bag of fries, heals 10 hunger.",1)
	g_Milk = ARP_RegisterItem("Milk","_Food","A box of milk, heals 15 hunger and, with thirst on, 30 thirst.",1)
	g_Hotdog = ARP_RegisterItem("Hotdog","_Food","A weiner wrapped in bread, heals 25 hunger.",1)
	g_Pizza = ARP_RegisterItem("Pizza","_Food","A slice of pepperoni pizza, heals 30 hunger.",1)
	g_Hamburger = ARP_RegisterItem("Hamburger","_Food","A hamburger made of beef, heals 40 hunger.",1)
	g_Pasta = ARP_RegisterItem("Pasta","_Food","A plate of pasta with tomato sauce, heals 50 hunger.",1)
	g_Steak = ARP_RegisterItem("Steak","_Food","A long well cooked piece of beef, heals 80 hunger.",1)
}

//public client_PreThink(id)
//	if(g_Starving[id] || g_Eating[id])
//		entity_set_float(id,EV_FL_maxspeed,g_MaxSpeed[id] / (1.5 * (g_Starving[id] ? 1 : 0) + 1.5 * g_Eating[id]))

public _Food(id,ItemId)
{
	if(g_Eating[id])
	{
		client_print(id,print_chat,"[ARP] You are already eating.")
		return ARP_SetUserItemNum(id,ItemId,ARP_GetUserItemNum(id,ItemId) + 1)
	}
	
	new CurArray[4],Msg[9] = "eating"
	CurArray[0] = id
	CurArray[1] = ItemId
	
	if(ItemId == g_Soda)
	{
		CurArray[2] = 5
		Msg = "drinking"
	}
	else if(ItemId == g_Fries)
		CurArray[2] = 10
	else if(ItemId == g_Milk)
	{
		CurArray[2] = 15
		Msg = "drinking"
	}
	else if(ItemId == g_Hotdog)
		CurArray[2] = 25
	else if(ItemId == g_Pizza)
		CurArray[2] = 30
	else if(ItemId == g_Hamburger)
		CurArray[2] = 40
	else if(ItemId == g_Pasta)
		CurArray[2] = 50
	else if(ItemId == g_Steak)
		CurArray[2] = 80
	
	CurArray[3] = Msg[0] == 'e' ? 1 : 0
	
	// a drink also quenches thirst, so a thirsty player may drink with no hunger to heal
	if(ARP_GetUserHunger(id) < CurArray[2] && !(get_pcvar_num(p_ThirstEnabled) && g_Thirst[id] > 0 && (ItemId == g_Soda || ItemId == g_Milk)))
	{
		ARP_SetUserItemNum(id,ItemId,ARP_GetUserItemNum(id,ItemId) + 1)
		return client_print(id,print_chat,"[ARP] You don't feel like %s this right now.",Msg)
	}
	
	new ItemName[33]
	ARP_GetItemName(ItemId,ItemName,32)
	
	client_print(id,print_chat,"[ARP] You are %s the %s.",Msg,ItemName)
	
	//if(!g_Starving[id]) g_MaxSpeed[id] = entity_get_float(id,EV_FL_maxspeed)
	ARP_SetUserSpeed(id,Speed_Mul,0.5)
	g_Eating[id] = 1
	
	ARP_ItemSet(id)
	
	set_task(1.0,"Eat",_,CurArray,3)
	
	return PLUGIN_CONTINUE
}

public Eat(CurArray[4])
{
	new id = CurArray[0],Food = CurArray[2],Hunger = ARP_GetUserHunger(id)
	
	if(Food > 5 && Hunger > 0)
	{
		Food -= 5
		ARP_SetUserHunger(id,Hunger - 5)
		
		CurArray[2] = Food
		
		set_task(1.0,"Eat",_,CurArray,3)
	}
	else
	{
		ARP_SetUserHunger(id,Hunger - Food)
		
		if(CurArray[1] == g_Soda) g_Thirst[id] = max(g_Thirst[id] - 35,0)
		else if(CurArray[1] == g_Milk) g_Thirst[id] = max(g_Thirst[id] - 30,0)
		
		new ItemName[33]
		ARP_GetItemName(CurArray[1],ItemName,32)
		
		client_print(id,print_chat,"[ARP] You are done %s the %s.",CurArray[3] ? "drinking" : "eating",ItemName)
		
		ARP_ItemDone(id)
		
		if(g_Starving[id])
			switch(Hunger)
			{
				case 75 .. 90 : g_Starving[id] = 1
				case 0 .. 74 : g_Starving[id] = 0
			}
		
		ARP_SetUserSpeed(id,Speed_Mul,2.0)
		
		g_Eating[id] = 0
	}
}