#include <amxmodx>
#include <ApolloRP>
#include <ApolloRP_Chat>

// H9: ARP_PropertyTax -- an owned property costs its owner money, taken from his bank every few minutes (docs\APOLLO_RP.txt, section 11; ORIGIN.txt item 42).
//
// THE TOLL. Every arp_h9_tax_minutes minutes of the map's time each property that has an owner costs its owner arp_h9_tax_flat plus arp_h9_tax_percent per cent of what the
// property cost him, rounded up to a whole number (at least 1 when the sum is above 0; the percent and the flat sum count to the hundredth, and the sum is worked out in whole
// numbers, never in floats). It is taken from the BANK, never the wallet, and the bank never goes below 0: what is there is taken, and the rest is told to the owner and forgotten
// (no debt, no eviction). The minutes, the percent and the flat sum are read at every toll, so a change needs no restart. arp_h9_tax 0 is stock Apollo RP: the plugin reads nothing,
// writes nothing and answers no command. The clock starts with the map (a restart or a map change starts it again, so nobody is charged for the time the server was down), and the
// owner of the moment pays: a property sold or given away since the last toll is its new owner's.
//
// THE PRICE. Apollo RP sets a property's price to 0 when it is bought (the price is what an owner asks while the property is for sale), so the percent is taken of the price the
// property was bought at. This plugin keeps it, from the event Property_Buy, in a table of its own (arp_h9_taxbase: one row for each property of a map). A property with no such
// row counts as its price, which is 0 unless it is for sale, and pays the flat sum alone; arp_h9_tax_value gives a property its price by hand.
//
// AN OWNER IN THE GAME whose character has loaded is charged at once, in his bank in the core's memory (ARP saves it), and told in one [ARP] line (a popup on an H9 game,
// chat on any other). An owner whose character has not loaded yet is left out of that toll: his bank in the database is not touched while he is connected, because the bank in
// memory is the truth and the core writes it.
//
// AN OWNER WHO IS AWAY is charged in the database, in the bank of his character (the users table of the map), and what was taken is added to his row of the table arp_h9_tax
// (authid, taken, unpaid, tolls, props, updated). The next time he is in the game and alive, once ARP has loaded him, he is shown ONE popup with what was taken in all while he
// was away, over how many tolls and for how many properties (and what could not be taken), and the row is deleted. A player who owns nothing is never charged and never told.
// The row and the bank are changed by two statements that the database's one worker runs back to back, the row first (it reads the bank as it was) and the bank second, and
// only when the row is there; so a statement that fails leaves the bank alone, and nothing is ever tried again in its place.
//
// The tables are made with CREATE TABLE IF NOT EXISTS the first time they are needed, a query that waits (as ARP_Inventory's is); no row of any ARP table is added, and going
// back is dropping them. A failed query is said once in the log and the database is left alone for a minute; the delete of a returning player's row, which also waits, is tried
// again a few seconds later (five times) without stopping anything else.

#pragma dynamic 8192

#define TAX_OWNERS       160     // owners one toll holds; the properties of any beyond them are left out (the log says so)
#define TAX_BASES        256     // properties whose price at the sale is kept in memory
#define TAX_KEY_FULL     35      // the characters of an H9XASH authid ("ID_" and 32 digits), which is a character's key
#define TAX_KEY_CUT      32      // the fewest characters of such a key that a core native leaves (see tax_cut)
#define TAX_NAME_SHOWN   20      // characters of a property's name that a line shows
#define TAX_NAMES        3       // property names a line lists before "and N more"
#define TAX_MAX_AMOUNT   10000000 // the most one property costs in one toll
#define TAX_MAX_VALUE    100000000 // the most a property counts as having cost
#define TAX_LINE_MAX     176     // characters of an [ARP] line: a popup holds 191 and a chat line 189 bytes, and each "$" may grow to two
#define TAX_LIST_MAX     24      // properties that say /tax lists in the console
#define TAX_BEAT         1.0     // seconds between the looks at the clock and at the players who wait for their popup
#define TAX_AWAY_DELAY   4.0     // seconds a player has been alive when he is shown what was taken while he was away
#define TAX_AWAY_RETRY   5.0     // seconds before the delete of his row is tried again, when it failed
#define TAX_AWAY_TRIES   5       // times it is tried before he is left for his next visit
#define TAX_DB_BACKOFF   60.0    // seconds nothing is tried again after the database failed
#define TAX_TASK_BEAT    7701

// the kinds of query whose answer TaxDbDone is given
#define TAX_Q_RECORD     1
#define TAX_Q_BANK       2
#define TAX_Q_PRICE      3

// the statements; every %s that is not a number is a table name, a key's test or a piece built below
#define TAX_SQL_TABLE_SQLITE   "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),taken INT(11),unpaid INT(11),tolls INT(11),props INT(11),updated INT(11),UNIQUE (authid))"
#define TAX_SQL_TABLE_MYSQL    "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),taken INT(11),unpaid INT(11),tolls INT(11),props INT(11),updated INT(11),UNIQUE KEY (authid))"
#define TAX_SQL_BASE_SQLITE    "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),name VARCHAR(66),price INT(11),UNIQUE (tbl,name))"
#define TAX_SQL_BASE_MYSQL     "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),name VARCHAR(66),price INT(11),UNIQUE KEY (tbl,name))"
#define TAX_SQL_RECORD         "%s %s (authid,taken,unpaid,tolls,props,updated) SELECT u.authid,IFNULL(t.taken,0)+%s,IFNULL(t.unpaid,0)+%d-%s,IFNULL(t.tolls,0)+1,%d,%d FROM %s u LEFT JOIN %s t ON t.authid=u.authid WHERE %s"
#define TAX_SQL_BANK           "UPDATE %s SET bankmoney=CASE WHEN bankmoney>%d THEN bankmoney-%d ELSE 0 END WHERE %s AND bankmoney>0 AND EXISTS (SELECT 1 FROM %s WHERE %s AND updated=%d)"
#define TAX_SQL_READ           "SELECT taken,unpaid,tolls,props,updated FROM %s WHERE authid='%s'"
#define TAX_SQL_CLEAR          "DELETE FROM %s WHERE authid='%s' AND updated=%d"
#define TAX_SQL_PRICES         "SELECT name,price FROM %s WHERE tbl='%s'"
#define TAX_SQL_PRICE_SQLITE   "INSERT OR REPLACE INTO %s (tbl,name,price) VALUES ('%s','%s',%d)"
#define TAX_SQL_PRICE_MYSQL    "REPLACE INTO %s (tbl,name,price) VALUES ('%s','%s',%d)"

// the cvars
new p_Tax
new p_Minutes
new p_Percent
new p_Flat

// the tables: ARP_GetTable gives the users table and the property table of the map (arp.ini and the map's own arp.ini name them); the record table follows the users table, so that
// characters kept apart by a map's own users table keep their records apart too
new g_UsersTable[64]
new g_PropTable[64]
new g_TaxTable[64]
new g_BaseTable[] = "arp_h9_taxbase"
new g_DbMade                                    // the tables are there
new Float:g_DbFailUntil                         // after a query failed nothing is tried before this game time
new g_DbFails
new g_DbWrites                                  // statements handed to the database, and rows read, since the map began (arp_h9_tax_dump says)
new g_DbReads

// the rates of the toll in whole numbers (tax_rates)
new g_Pm                                        // the percent in hundredths of a per cent
new g_FlatI                                     // the flat sum in whole money
new g_FlatC                                     // and the hundredths of it

// the clock
new g_Inited                                    // the prices of this map's properties have been asked for
new g_BaseLoaded                                // and have come
new Float:g_LastToll
new Float:g_NextToll
new Float:g_Minutes                             // the interval g_NextToll was worked out for
new g_Tolls                                     // tolls since the map began

// the last toll (arp_h9_tax_dump says)
new g_LastOwners
new g_LastOnline
new g_LastOffline
new g_LastSkipped
new g_LastProps
new g_LastTaken
new g_LastUnpaid
new g_LastAway
new g_LastCut

// what each property cost when it was bought
new g_BaseName[TAX_BASES][66]
new g_BasePrice[TAX_BASES]
new g_BaseNum

// the owners of one toll: their key as the core gives it, what they owe, how many properties, the first few of them (their numbers in ARP's list)
new g_OwnKey[TAX_OWNERS][36]
new g_OwnTotal[TAX_OWNERS]
new g_OwnProps[TAX_OWNERS]
new g_OwnShown[TAX_OWNERS][TAX_NAMES]
new g_OwnNum
new g_PKey[MAX_PLAYERS + 1][36]                 // the key of each player in the game, as of the toll

// what a player who has just joined is owed to be told
new g_Seq[MAX_PLAYERS + 1]                      // his joins and leaves counted, so that the answer to an old read is ignored
new g_Away[MAX_PLAYERS + 1]                     // 0 nothing, 1 his row has been asked for, 2 his row is in hand and he is to be shown it
new g_AwayKey[MAX_PLAYERS + 1][36]
new g_AwayTaken[MAX_PLAYERS + 1]
new g_AwayUnpaid[MAX_PLAYERS + 1]
new g_AwayTolls[MAX_PLAYERS + 1]
new g_AwayProps[MAX_PLAYERS + 1]
new g_AwayStamp[MAX_PLAYERS + 1]
new g_AwayTries[MAX_PLAYERS + 1]                // how many times the delete of his row has failed
new Float:g_AwayAt[MAX_PLAYERS + 1]             // when he is shown it: TAX_AWAY_DELAY after he was first seen alive (0: not seen alive yet)

// ---------------------------------------------------------------------------------------------------------------------- start

public ARP_Init()
{
	ARP_RegisterPlugin("PropertyTax",ARP_VERSION,"H9","Takes a property tax from the bank of every property's owner")

	ARP_RegisterEvent("Player_Ready","EventReady")
	ARP_RegisterEvent("Property_Buy","EventPropertyBuy")
}

public plugin_init()
{
	// arp_h9_tax is the switch (0: stock Apollo RP); a toll comes every arp_h9_tax_minutes minutes and takes arp_h9_tax_flat plus arp_h9_tax_percent per cent of what each property cost,
	// from its owner's bank
	p_Tax = register_cvar("arp_h9_tax","1")
	p_Minutes = register_cvar("arp_h9_tax_minutes","15")
	p_Percent = register_cvar("arp_h9_tax_percent","1.0")
	p_Flat = register_cvar("arp_h9_tax_flat","0")

	ARP_RegisterChat("/tax","SayTax","- shows what your properties cost in property tax at each toll, and when the next toll is")

	ARP_AddCommand("arp_h9_tax_dump","(ADMIN) Shows the property tax: its switches, its clock, the last toll and the database")
	register_concmd("arp_h9_tax_dump","CmdDump",_,"- the property tax: switches, clock, the last toll, the database")
	ARP_AddCommand("arp_h9_tax_value","(ADMIN) <internal name> <price> - the price a property counts as having cost, which the percent of the tax is taken of")
	register_concmd("arp_h9_tax_value","CmdValue",_,"<internal name> <price> - the price a property counts as having cost (0: its own price again)")

	set_task(TAX_BEAT,"TaxBeat",TAX_TASK_BEAT,_,_,"b")
}

public ARP_Error(const Reason[])
	pause("d")

public client_putinserver(id)
	tax_reset(id)

public client_disconnected(id)
	tax_reset(id)

// a slot starts again: nothing is owed to him, and the answer to a read asked for before is ignored
stock tax_reset(id)
{
	if(id < 1 || id > MAX_PLAYERS)
		return

	g_Seq[id]++
	g_Away[id] = 0
	g_AwayAt[id] = 0.0
	g_AwayTries[id] = 0
}

// ---------------------------------------------------------------------------------------------------------------------- the cvars

// the interval in minutes, 1 to 10080
stock Float:tax_minutes()
{
	new Float:v = get_pcvar_float(p_Minutes)

	if(v < 1.0)
		return 1.0

	return v > 10080.0 ? 10080.0 : v
}

// per cent of the price, 0 to 100 (counted to the hundredth)
stock Float:tax_percent()
{
	new Float:v = get_pcvar_float(p_Percent)

	if(v < 0.0)
		return 0.0

	return v > 100.0 ? 100.0 : v
}

// the flat sum for each property, 0 to TAX_MAX_AMOUNT (counted to the hundredth)
stock Float:tax_flat()
{
	new Float:v = get_pcvar_float(p_Flat)

	if(v < 0.0)
		return 0.0

	return v > float(TAX_MAX_AMOUNT) ? float(TAX_MAX_AMOUNT) : v
}

// ---------------------------------------------------------------------------------------------------------------------- keys and text

// the key of a player's character, the one ARP keeps his rows under (ARP_GetUserKey); none for a bot, a player who is not here and an authid ARP does not save a character under
stock tax_key(id,key[],len)
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

// whether the text of an owner's key (what ARP_PropertyGetOwnerAuth gives) is a character's key that a core native has cut. H9XASH's authids are 35 characters ("ID_" and 32 digits), and the
// core copies an owner's key into 33 characters when it hands it back (ARP_PropertyGetOwnerAuth) and keeps 32 of it when it is set (ARP_PropertySetOwnerAuth, which an admin's
// arp_setproperty and ARP_PropertySetOwner use): so an owner's key of 32, 33 or 34 characters is the beginning of the key of a character, and the other keys (a Steam id has fewer than 32
// characters) are whole.
stock bool:tax_cut(const owner[])
{
	new n = strlen(owner)

	return n >= TAX_KEY_CUT && n < TAX_KEY_FULL
}

// whether the owner of a property is the character with this key: the same text, or a cut key that is the beginning of it
stock bool:tax_owns(const owner[],const key[])
{
	if(!owner[0] || !key[0])
		return false

	if(equali(owner,key))
		return true

	return tax_cut(owner) && equali(owner,key,strlen(owner))
}

// whether two texts of an owner's key are the key of one character: the same text, or the shorter is a cut key that is the beginning of the other
stock bool:tax_same(const a[],const b[])
{
	if(equali(a,b))
		return true

	if(strlen(a) <= strlen(b))
		return tax_cut(a) && equali(a,b,strlen(a))

	return tax_cut(b) && equali(a,b,strlen(b))
}

// the test for an owner's key in a column of the database: the key, or, for a cut key, the beginning of the column's text as long as the cut key is
stock tax_key_cond(const col[],const owner[],out[],len)
{
	new key[72]
	copy(key,71,owner)
	ARP_SqlEscape(key,71)

	if(tax_cut(owner))
		return formatex(out,len,"SUBSTR(%s,1,%d)='%s'",col,strlen(owner),key)

	return formatex(out,len,"%s='%s'",col,key)
}

// a property's name as a line may carry it: printable ASCII, no "%" (a client takes the text of a chat line as a format, and a stray one is dangerous), TAX_NAME_SHOWN characters at most
stock tax_clean(const src[],dst[],len)
{
	new n,cut

	for(new i;src[i];i++)
	{
		if(n >= len || n >= TAX_NAME_SHOWN)
		{
			cut = 1
			break
		}

		dst[n++] = (src[i] < 32 || src[i] > 126 || src[i] == '%') ? '?' : src[i]
	}

	if(cut && n + 2 <= len)
	{
		dst[n++] = '.'
		dst[n++] = '.'
	}

	dst[n] = 0
}

// the name of a property for a line: its name as players see it, or its internal name
stock tax_prop_name(property,out[],len)
{
	new raw[66]
	raw[0] = 0

	ARP_PropertyGetExternalName(property,raw,63)
	if(!raw[0])
		ARP_PropertyGetInternalName(property,raw,63)

	tax_clean(raw,out,len)
}

// the properties of an owner of this toll as a list: "A", "A and B", "A, B and C", and "A, B, C and 4 more" past TAX_NAMES
stock tax_names(o,out[],len)
{
	new n = g_OwnProps[o],shown = min(n,TAX_NAMES),name[TAX_NAME_SHOWN + 4],used

	out[0] = 0

	for(new i;i < shown;i++)
	{
		tax_prop_name(g_OwnShown[o][i],name,TAX_NAME_SHOWN + 3)

		if(i > 0 && i == shown - 1 && n == shown)
			used += formatex(out[used],len - used," and ")
		else if(i > 0)
			used += formatex(out[used],len - used,", ")

		used += formatex(out[used],len - used,"%s",name)
	}

	if(n > shown)
		formatex(out[used],len - used," and %d more",n - shown)
}

// "15 minutes", "1 minute", "1.5 minutes"
stock tax_span(Float:minutes,out[],len)
{
	if(minutes == float(floatround(minutes,floatround_floor)))
		formatex(out,len,"%d minute%s",floatround(minutes,floatround_floor),minutes < 1.5 ? "" : "s")
	else
		formatex(out,len,"%.1f minutes",minutes)
}

// "in 9 minutes", "in 1 minute", "in less than a minute"
stock tax_in(Float:seconds,out[],len)
{
	if(seconds < 60.0)
	{
		copy(out,len,"in less than a minute")

		return
	}

	new m = floatround(seconds / 60.0,floatround_ceil)

	formatex(out,len,"in %d minute%s",m,m == 1 ? "" : "s")
}

// ---------------------------------------------------------------------------------------------------------------------- the database

// a failed query: said once in a while in the log, and the database is left alone for a time
stock tax_db_fail(const what[],const why[])
{
	g_DbFails++

	if(get_gametime() >= g_DbFailUntil)
		log_amx("[ARP] property tax: the database failed (%s: %s): nothing is read or written for now",what,why)

	g_DbFailUntil = get_gametime() + TAX_DB_BACKOFF
}

// the table names, once: the users table and the property table of the map, and the record table that goes with the users table (its name's letters, digits and underscores)
stock tax_tables()
{
	ARP_GetTable(USERS,g_UsersTable,63)
	ARP_GetTable(PROPERTIES,g_PropTable,63)

	copy(g_TaxTable,63,"arp_h9_tax")

	if(equali(g_UsersTable,"arp_users"))
		return

	new n = strlen(g_TaxTable)
	g_TaxTable[n++] = '_'

	for(new i;g_UsersTable[i] && n < 63;i++)
	{
		new c = g_UsersTable[i]
		if((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')
			g_TaxTable[n++] = c
	}

	g_TaxTable[n] = 0
}

// runs one statement on a connection that waits: the rows it changed, or -1, with the reason, when it fails
stock tax_exec(Handle:db,const query[],why[],len)
{
	new Handle:st = SQL_PrepareQuery(db,"%s",query),rows = -1

	if(SQL_Execute(st))
		rows = SQL_AffectedRows(st)
	else
		SQL_QueryError(st,why,len)

	SQL_FreeHandle(st)

	return rows
}

// whether the tables are there (made once, here, with queries that wait: a few milliseconds, and the queries after them can rely on it)
stock bool:tax_db_table()
{
	if(g_DbMade)
		return true

	tax_tables()

	new err,msg[128],Handle:db = SQL_Connect(ARP_SqlHandle(),err,msg,127)
	if(db == Empty_Handle || err)
	{
		tax_db_fail("connect",msg)

		return false
	}

	new query[300],bool:ok

	if(ARP_SqlMode() == MYSQL)
		formatex(query,299,TAX_SQL_TABLE_MYSQL,g_TaxTable)
	else
		formatex(query,299,TAX_SQL_TABLE_SQLITE,g_TaxTable)

	ok = tax_exec(db,query,msg,127) >= 0

	if(ok)
	{
		if(ARP_SqlMode() == MYSQL)
			formatex(query,299,TAX_SQL_BASE_MYSQL,g_BaseTable)
		else
			formatex(query,299,TAX_SQL_BASE_SQLITE,g_BaseTable)

		ok = tax_exec(db,query,msg,127) >= 0
	}

	SQL_FreeHandle(db)

	if(!ok)
	{
		tax_db_fail("create",msg)

		return false
	}

	g_DbMade = 1

	return true
}

// whether the database may be read and written now: the switch is on, the database is up, nothing failed a moment ago, and the tables are there
stock bool:tax_db_ready()
{
	if(!get_pcvar_num(p_Tax) || get_gametime() < g_DbFailUntil || ARP_SqlHandle() == Empty_Handle)
		return false

	return tax_db_table()
}

// the answer to a statement that changes something: a failed one is said once, and is not tried again
public TaxDbDone(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused query,size,queuetime

	if(failstate == TQUERY_SUCCESS && !errnum)
		return PLUGIN_CONTINUE

	new what[96]

	switch(data[0])
	{
		case TAX_Q_RECORD:
			formatex(what,95,"row of a toll of $%d",data[1])
		case TAX_Q_BANK:
			formatex(what,95,"bank for a toll of $%d, whose row was written: nothing was taken",data[1])
		default:
			copy(what,95,"price")
	}

	tax_db_fail(what,error)

	return PLUGIN_CONTINUE
}

// ---------------------------------------------------------------------------------------------------------------------- the price a property cost

stock tax_base_find(const name[])
{
	for(new i;i < g_BaseNum;i++)
		if(equali(g_BaseName[i],name))
			return i

	return -1
}

stock tax_base_add(const name[],price)
{
	if(g_BaseNum >= TAX_BASES)
		return -1

	copy(g_BaseName[g_BaseNum],65,name)
	g_BasePrice[g_BaseNum] = price

	return g_BaseNum++
}

// remembers what a property cost: in memory, and in the table
stock tax_base_set(const name[],price)
{
	new i = tax_base_find(name)

	if(i >= 0)
		g_BasePrice[i] = price
	else if(tax_base_add(name,price) < 0)
		log_amx("[ARP] property tax: more than %d properties have a price of their own; %s is not kept",TAX_BASES,name)

	if(!tax_db_ready())
		return

	new tbl[140],nm[140],query[400],data[1]

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	copy(nm,139,name)
	ARP_SqlEscape(nm,139)

	if(ARP_SqlMode() == MYSQL)
		formatex(query,399,TAX_SQL_PRICE_MYSQL,g_BaseTable,tbl,nm,price)
	else
		formatex(query,399,TAX_SQL_PRICE_SQLITE,g_BaseTable,tbl,nm,price)

	data[0] = TAX_Q_PRICE
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,1)
}

// the prices of this map's properties are asked for, once the database is up: the toll waits for them
stock tax_init()
{
	if(g_Inited || ARP_SqlHandle() == Empty_Handle || !tax_db_ready())
		return

	new tbl[140],query[300],data[1]

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	formatex(query,299,TAX_SQL_PRICES,g_BaseTable,tbl)

	data[0] = TAX_Q_PRICE
	g_Inited = 1
	g_BaseLoaded = 0
	g_DbReads++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbPrices",query,data,1)
}

// the answer: the rows are added to what memory has (a price learned since the map began is fresher than a row)
public TaxDbPrices(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused data,size,queuetime

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		tax_db_fail("prices",error)
		g_Inited = 0

		return PLUGIN_CONTINUE
	}

	new name[66],price

	while(SQL_MoreResults(query))
	{
		SQL_ReadResult(query,0,name,65)
		price = SQL_ReadResult(query,1)

		if(price > 0 && tax_base_find(name) < 0)
			tax_base_add(name,price)

		SQL_NextRow(query)
	}

	g_BaseLoaded = 1

	return PLUGIN_CONTINUE
}

// a property is bought: its price now is what it costs the buyer, and ARP sets it to 0 when the sale is done
public EventPropertyBuy(Name[],Data[],Len)
{
	#pragma unused Name,Len

	if(!get_pcvar_num(p_Tax))
		return PLUGIN_CONTINUE

	new property = Data[1]
	if(!ARP_ValidProperty(property))
		return PLUGIN_CONTINUE

	new price = ARP_PropertyGetPrice(property)
	if(price < 1)
		return PLUGIN_CONTINUE

	new name[66]
	ARP_PropertyGetInternalName(property,name,65)
	tax_base_set(name,price)

	return PLUGIN_CONTINUE
}

// what the percent is taken of: the price the property was bought at, or else its price now (0 unless it is for sale)
stock tax_value(property)
{
	new name[66]
	ARP_PropertyGetInternalName(property,name,65)

	new i = tax_base_find(name)
	if(i >= 0 && g_BasePrice[i] > 0)
		return g_BasePrice[i]

	return max(ARP_PropertyGetPrice(property),0)
}

// the cvars as whole numbers, once for a toll: the percent in hundredths of a per cent, the flat sum in whole money and hundredths of it. Money is never worked out in floats (a float of
// 32 bits cannot tell 9.0001 from 9 at the sums that matter), so the amount of a property is exact for percents and flat sums given to the hundredth.
stock tax_rates()
{
	new Float:flat = tax_flat()

	g_Pm = floatround(tax_percent() * 100.0)
	g_FlatI = floatround(flat,floatround_floor)
	g_FlatC = floatround((flat - float(g_FlatI)) * 100.0)

	if(g_FlatC >= 100)
	{
		g_FlatI++
		g_FlatC = 0
	}
}

// what a property costs its owner at a toll: flat plus the percent of its value, rounded up to a whole number (so at least 1 when the sum is above 0), never more than TAX_MAX_AMOUNT.
// The value is split at 10000 so that no product passes 32 bits: value * percent / 10000 = (value / 10000) * percent + (value % 10000) * percent / 10000, the first a whole number.
stock tax_amount(property)
{
	new value = min(tax_value(property),TAX_MAX_VALUE)
	new amount = g_FlatI + (value / 10000) * g_Pm + (g_FlatC * 100 + (value % 10000) * g_Pm + 9999) / 10000

	return min(amount,TAX_MAX_AMOUNT)
}

// ---------------------------------------------------------------------------------------------------------------------- the clock

public TaxBeat()
{
	if(!get_pcvar_num(p_Tax))
	{
		g_LastToll = 0.0
		g_NextToll = 0.0

		return
	}

	tax_init()

	new Float:now = get_gametime(),Float:minutes = tax_minutes()

	if(g_LastToll == 0.0)
		g_LastToll = now

	if(g_NextToll == 0.0 || minutes != g_Minutes)
	{
		g_Minutes = minutes
		g_NextToll = g_LastToll + minutes * 60.0
	}

	// a toll waits for the prices of the properties; a clock that is past due (a shorter interval) tolls at once, once
	if(now >= g_NextToll && g_BaseLoaded)
	{
		tax_toll()

		g_LastToll = now
		g_NextToll = now + minutes * 60.0
	}

	tax_away_pass(now)
}

// ---------------------------------------------------------------------------------------------------------------------- the toll

// the slot of an owner in this toll (made when it is the first property of his), or -1 when the toll holds no more. The properties of one character can name him in more than one way (a bought
// property keeps his whole key and the core hands it back cut at 33 characters, one an admin gave him is kept cut at 32): they are one owner, and the longest text of his key is the one kept.
stock tax_owner(const key[])
{
	for(new i;i < g_OwnNum;i++)
	{
		if(!tax_same(g_OwnKey[i],key))
			continue

		if(strlen(key) > strlen(g_OwnKey[i]))
			copy(g_OwnKey[i],35,key)

		return i
	}

	if(g_OwnNum >= TAX_OWNERS)
		return -1

	new o = g_OwnNum++

	copy(g_OwnKey[o],35,key)
	g_OwnTotal[o] = 0
	g_OwnProps[o] = 0

	return o
}

// the player in the game whose character is this owner (0: none)
stock tax_online(const owner[],const players[],num)
{
	for(new i;i < num;i++)
		if(tax_owns(owner,g_PKey[players[i]]))
			return players[i]

	return 0
}

stock tax_toll()
{
	new owner[36],amount,o,left

	tax_rates()

	g_Tolls++
	g_LastOwners = 0
	g_LastOnline = 0
	g_LastOffline = 0
	g_LastSkipped = 0
	g_LastProps = 0
	g_LastTaken = 0
	g_LastUnpaid = 0
	g_LastAway = 0
	g_LastCut = 0
	g_OwnNum = 0

	// who owes what: the properties that have an owner, and what each costs
	for(new p = 1;ARP_ValidProperty(p);p++)
	{
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)

		if(!owner[0])
			continue

		amount = tax_amount(p)
		if(amount < 1)
			continue

		o = tax_owner(owner)
		if(o < 0)
		{
			left++

			continue
		}

		g_OwnTotal[o] = min(g_OwnTotal[o] + amount,2000000000)

		if(g_OwnProps[o] < TAX_NAMES)
			g_OwnShown[o][g_OwnProps[o]] = p

		g_OwnProps[o]++
		g_LastProps++
	}

	// who is in the game
	new players[MAX_PLAYERS],num
	get_players(players,num,"ch")

	for(new i;i < num;i++)
		tax_key(players[i],g_PKey[players[i]],35)

	new bool:dbOk = g_OwnNum > 0 && tax_db_ready()

	for(o = 0;o < g_OwnNum;o++)
	{
		new id = tax_online(g_OwnKey[o],players,num)

		g_LastOwners++

		if(tax_cut(g_OwnKey[o]))
			g_LastCut++

		if(id)
		{
			// his bank in memory is the truth while he is here, and until his character has loaded it is not his
			if(ARP_PlayerReady(id))
				tax_charge_online(id,o)
			else
				g_LastSkipped++
		}
		else if(dbOk)
			tax_charge_away(o)
		else
			g_LastSkipped++
	}

	log_amx("[ARP] property tax: toll %d: %d owners, %d in the game ($%d taken, $%d unpaid), %d away ($%d asked of the database), %d left out%s",g_Tolls,g_LastOwners,g_LastOnline,g_LastTaken,g_LastUnpaid,g_LastOffline,g_LastAway,g_LastSkipped,left ? " (and the properties of owners beyond the toll's room)" : "")
}

// an owner in the game: his bank, in memory, pays what it holds of what he owes, and he is told
stock tax_charge_online(id,o)
{
	new total = g_OwnTotal[o],bank = ARP_GetUserBank(id),take = bank > 0 ? min(bank,total) : 0,unpaid = total - take
	static line[192]

	if(take > 0)
		ARP_SetUserBank(id,bank - take)

	g_LastOnline++
	g_LastTaken += take
	g_LastUnpaid += unpaid

	tax_line_online(o,take,unpaid,line,191)
	client_print(id,print_chat,"%s",line)
}

// an owner who is away: two statements for the database's one worker to run back to back. The first adds the toll to his row (what the bank holds of it is taken, the rest is unpaid:
// it reads the bank as it is); the second takes it from his bank, never below 0, and only when the row with this time is there. A key the core has cut (tax_cut) is a test of the beginning
// of the column.
stock tax_charge_away(o)
{
	static query[1000],take[128],condU[160],condB[160],verb[24]
	new total = g_OwnTotal[o],stamp = get_systime(),data[2]

	tax_key_cond("u.authid",g_OwnKey[o],condU,159)
	tax_key_cond("authid",g_OwnKey[o],condB,159)
	formatex(take,127,"(CASE WHEN u.bankmoney>=%d THEN %d WHEN u.bankmoney>0 THEN u.bankmoney ELSE 0 END)",total,total)

	if(ARP_SqlMode() == MYSQL)
		copy(verb,23,"REPLACE INTO")
	else
		copy(verb,23,"INSERT OR REPLACE INTO")

	formatex(query,999,TAX_SQL_RECORD,verb,g_TaxTable,take,total,take,g_OwnProps[o],stamp,g_UsersTable,g_TaxTable,condU)
	data[0] = TAX_Q_RECORD
	data[1] = total
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,2)

	formatex(query,999,TAX_SQL_BANK,g_UsersTable,total,total,condB,g_TaxTable,condB,stamp)
	data[0] = TAX_Q_BANK
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,2)

	g_LastOffline++
	g_LastAway += total
}

// ---------------------------------------------------------------------------------------------------------------------- what an owner is told

// the line of a toll for an owner in the game
stock tax_line_online(o,take,unpaid,line[],len)
{
	new names[100]

	tax_names(o,names,99)
	tax_line_online_text(take,unpaid,names,line,len)

	// too long for a popup: the names give way to their number
	if(strlen(line) > TAX_LINE_MAX)
	{
		formatex(names,99,"%d propert%s",g_OwnProps[o],g_OwnProps[o] == 1 ? "y" : "ies")
		tax_line_online_text(take,unpaid,names,line,len)
	}
}

stock tax_line_online_text(take,unpaid,const names[],line[],len)
{
	if(unpaid < 1)
		formatex(line,len,"[ARP] Property tax: $%d taken from your bank for %s.",take,names)
	else if(take > 0)
		formatex(line,len,"[ARP] Property tax: $%d taken from your bank for %s; $%d could not be taken (not enough in your bank).",take,names,unpaid)
	else
		formatex(line,len,"[ARP] Property tax for %s: $%d could not be taken (not enough in your bank).",names,unpaid)
}

// the line for an owner who has been away: all the tolls since he left, in one
stock tax_line_away(taken,unpaid,tolls,props,line[],len)
{
	new what[48]

	formatex(what,47,"%d toll%s on %d propert%s",tolls,tolls == 1 ? "" : "s",props,props == 1 ? "y" : "ies")

	if(unpaid < 1)
		formatex(line,len,"[ARP] While you were away, property tax took $%d from your bank (%s).",taken,what)
	else if(taken > 0)
		formatex(line,len,"[ARP] While you were away, property tax took $%d from your bank (%s); $%d could not be taken (not enough in your bank).",taken,what,unpaid)
	else
		formatex(line,len,"[ARP] While you were away, property tax came to $%d (%s) and none of it could be taken (not enough in your bank).",unpaid,what)
}

// ---------------------------------------------------------------------------------------------------------------------- a player joins

// the character has loaded: his row, if he has one, is asked for. It is shown to him once he has been alive for a few seconds, and deleted with the showing.
public EventReady(Name[],Data[],Len)
{
	#pragma unused Name,Len

	new id = Data[0]

	tax_reset(id)

	if(!get_pcvar_num(p_Tax) || id < 1 || id > MAX_PLAYERS)
		return PLUGIN_CONTINUE

	tax_key(id,g_AwayKey[id],35)
	if(!g_AwayKey[id][0] || !tax_db_ready())
		return PLUGIN_CONTINUE

	new key[72],query[260],data[3]

	copy(key,71,g_AwayKey[id])
	ARP_SqlEscape(key,71)
	formatex(query,259,TAX_SQL_READ,g_TaxTable,key)

	data[0] = id
	data[1] = get_user_userid(id)
	data[2] = g_Seq[id]

	g_Away[id] = 1
	g_DbReads++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbRead",query,data,3)

	return PLUGIN_CONTINUE
}

// the answer to the read of a row: kept for the player, unless he is gone (or another joins in his slot) meanwhile
public TaxDbRead(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused size,queuetime

	new id = data[0]

	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || get_user_userid(id) != data[1] || g_Seq[id] != data[2] || g_Away[id] != 1)
		return PLUGIN_CONTINUE

	g_Away[id] = 0

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		tax_db_fail("read",error)

		return PLUGIN_CONTINUE
	}

	if(SQL_NumResults(query) < 1)
		return PLUGIN_CONTINUE

	g_AwayTaken[id] = SQL_ReadResult(query,0)
	g_AwayUnpaid[id] = SQL_ReadResult(query,1)
	g_AwayTolls[id] = SQL_ReadResult(query,2)
	g_AwayProps[id] = SQL_ReadResult(query,3)
	g_AwayStamp[id] = SQL_ReadResult(query,4)
	g_AwayAt[id] = 0.0
	g_Away[id] = 2

	return PLUGIN_CONTINUE
}

// once a second: a player whose row is in hand is shown it when he has been alive for TAX_AWAY_DELAY seconds (not while he picks a class or watches, and not before the game has
// drawn its HUD), and the delay starts again if he dies first
stock tax_away_pass(Float:now)
{
	new players[MAX_PLAYERS],num,id

	get_players(players,num,"ch")

	for(new i;i < num;i++)
	{
		id = players[i]

		if(g_Away[id] != 2)
			continue

		if(!is_user_alive(id))
		{
			g_AwayAt[id] = 0.0

			continue
		}

		if(g_AwayAt[id] == 0.0)
			g_AwayAt[id] = now + TAX_AWAY_DELAY
		else if(now >= g_AwayAt[id])
			tax_away_show(id)
	}
}

// the delete of a player's row failed (SQLite has one writer, and the module's worker may be writing a toll): said in the log the first time, tried again after TAX_AWAY_RETRY seconds, and
// given up after TAX_AWAY_TRIES (the row stays for his next visit). One such statement does not stop the database for the plugin: a toll is not held up by it.
stock tax_away_fail(id,const what[],const why[])
{
	if(g_AwayTries[id]++ == 0)
		log_amx("[ARP] property tax: %s for a player's row failed (%s): tried again shortly",what,why)

	if(g_AwayTries[id] >= TAX_AWAY_TRIES)
	{
		log_amx("[ARP] property tax: the row of a player could not be deleted (%s): he is left for his next visit",why)
		g_Away[id] = 0

		return
	}

	g_AwayAt[id] = get_gametime() + TAX_AWAY_RETRY
}

// his row is deleted (the row he is shown: a row a toll has made since has another time and stays for his next visit), with a statement that waits, and he is told only when that
// statement removed it: a row that is not gone is never shown, and a row somebody else removed is not shown twice. A statement that fails leaves him waiting for the next try.
stock tax_away_show(id)
{
	if(!tax_db_ready())
		return

	new err,msg[128],Handle:db = SQL_Connect(ARP_SqlHandle(),err,msg,127)
	if(db == Empty_Handle || err)
	{
		tax_away_fail(id,"connecting",msg)

		return
	}

	new key[72],query[300],rows
	static line[192]

	copy(key,71,g_AwayKey[id])
	ARP_SqlEscape(key,71)
	formatex(query,299,TAX_SQL_CLEAR,g_TaxTable,key,g_AwayStamp[id])

	rows = tax_exec(db,query,msg,127)
	SQL_FreeHandle(db)

	g_DbWrites++

	if(rows < 0)
	{
		tax_away_fail(id,"the delete",msg)

		return
	}

	g_Away[id] = 0

	if(rows < 1 || g_AwayTaken[id] + g_AwayUnpaid[id] < 1)
		return

	tax_line_away(g_AwayTaken[id],g_AwayUnpaid[id],g_AwayTolls[id],g_AwayProps[id],line,191)
	client_print(id,print_chat,"%s",line)
}

// ---------------------------------------------------------------------------------------------------------------------- say /tax

// what the owner's properties cost at a toll: a line in chat (a popup on an H9 game), and the list in the console
public SayTax(id,Mode,Args[])
{
	#pragma unused Mode,Args

	if(!get_pcvar_num(p_Tax))
		return PLUGIN_CONTINUE

	if(!ARP_PlayerReady(id))
	{
		client_print(id,print_chat,"[ARP] Your character has not loaded yet.")

		return PLUGIN_HANDLED
	}

	new key[36],owner[36],count,total,amount,listed
	new listProp[TAX_LIST_MAX],listAmount[TAX_LIST_MAX]

	tax_rates()
	tax_key(id,key,35)

	for(new p = 1;key[0] && ARP_ValidProperty(p);p++)
	{
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)

		if(!tax_owns(owner,key))
			continue

		amount = tax_amount(p)
		count++
		total = min(total + amount,2000000000)

		if(listed < TAX_LIST_MAX)
		{
			listProp[listed] = p
			listAmount[listed++] = amount
		}
	}

	if(!count)
	{
		client_print(id,print_chat,"[ARP] You own no property, so you pay no property tax.")

		return PLUGIN_HANDLED
	}

	new span[32],next[32],Float:left = g_NextToll > 0.0 ? g_NextToll - get_gametime() : tax_minutes() * 60.0

	tax_span(tax_minutes(),span,31)
	tax_in(left,next,31)

	if(total < 1)
	{
		client_print(id,print_chat,"[ARP] Property tax: none of your %d propert%s is charged at the moment.",count,count == 1 ? "y" : "ies")

		return PLUGIN_HANDLED
	}

	client_print(id,print_chat,"[ARP] Property tax: $%d at each toll, every %s, for %d propert%s; the next toll is %s.",total,span,count,count == 1 ? "y" : "ies",next)

	new name[TAX_NAME_SHOWN + 4]

	client_print(id,print_console,"Property tax, every %s (the next toll is %s):",span,next)

	for(new i;i < listed;i++)
	{
		tax_prop_name(listProp[i],name,TAX_NAME_SHOWN + 3)
		client_print(id,print_console,"  %s: $%d",name,listAmount[i])
	}

	if(count > listed)
		client_print(id,print_console,"  and %d more",count - listed)

	client_print(id,print_console,"  Total: $%d",total)

	return PLUGIN_HANDLED
}

// ---------------------------------------------------------------------------------------------------------------------- console commands

// arp_h9_tax_dump: the switches, the clock, the last toll and the database, for a server that is looked at with nobody at a screen
public CmdDump(id,level,cid)
{
	#pragma unused level

	if(!ARP_CmdAccess(id,cid,1))
		return PLUGIN_HANDLED

	new Float:now = get_gametime(),pending

	for(new i = 1;i <= MAX_PLAYERS;i++)
		if(g_Away[i])
			pending++

	tax_rates()

	console_print(id,"TAX on=%d minutes=%.1f percent=%.2f flat=%.2f (as counted: %d hundredths of a per cent, %d.%02d) next=%d tolls=%d",get_pcvar_num(p_Tax),tax_minutes(),tax_percent(),tax_flat(),g_Pm,g_FlatI,g_FlatC,g_NextToll > 0.0 ? floatround(g_NextToll - now) : -1,g_Tolls)
	console_print(id,"LAST owners=%d properties=%d in_game=%d taken=%d unpaid=%d away=%d asked=%d left_out=%d cut_keys=%d",g_LastOwners,g_LastProps,g_LastOnline,g_LastTaken,g_LastUnpaid,g_LastOffline,g_LastAway,g_LastSkipped,g_LastCut)
	console_print(id,"DB made=%d loaded=%d prices=%d failed=%d backoff=%d writes=%d reads=%d waiting=%d",g_DbMade,g_BaseLoaded,g_BaseNum,g_DbFails,g_DbFailUntil > now ? floatround(g_DbFailUntil - now) : 0,g_DbWrites,g_DbReads,pending)
	console_print(id,"TABLES users=%s properties=%s record=%s prices=%s",g_UsersTable,g_PropTable,g_TaxTable,g_BaseTable)

	return PLUGIN_HANDLED
}

// arp_h9_tax_value <internal name> <price>: what a property counts as having cost; 0 forgets it, and the property counts as its own price again
public CmdValue(id,level,cid)
{
	#pragma unused level

	if(!ARP_CmdAccess(id,cid,3))
		return PLUGIN_HANDLED

	if(!get_pcvar_num(p_Tax))
	{
		console_print(id,"[ARP] arp_h9_tax is 0: the property tax does nothing.")

		return PLUGIN_HANDLED
	}

	new arg[66],val[16],name[66],property,price,admin[33],authid[36],userid

	read_argv(1,arg,64)
	read_argv(2,val,15)
	remove_quotes(arg)
	trim(arg)
	remove_quotes(val)
	trim(val)

	property = ARP_PropertyMatch(_,_,arg)
	if(!property)
	{
		console_print(id,"[ARP] Property ^"%s^" does not exist.",arg)

		return PLUGIN_HANDLED
	}

	if(!is_str_num(val) || strlen(val) > 9)
	{
		console_print(id,"[ARP] The price is a whole number of 0 or more.")

		return PLUGIN_HANDLED
	}

	price = str_to_num(val)
	ARP_PropertyGetInternalName(property,name,65)
	tax_base_set(name,price)

	if(id)
	{
		get_user_name(id,admin,32)
		get_user_authid(id,authid,35)
		userid = get_user_userid(id)
	}
	else
	{
		copy(admin,32,"Server")
		copy(authid,35,"-")
	}

	console_print(id,"[ARP] The property ^"%s^" counts as having cost $%d for the property tax.",name,price)
	ARP_Log("Cmd: ^"%s<%d><%s> set the tax price of property ^"%s^" (price ^"$%d^")",admin,userid,authid,name,price)

	return PLUGIN_HANDLED
}
