#include <amxmodx>
#include <ApolloRP>
#include <ApolloRP_Chat>
#include <ApolloRP_VGui>

// H9: ARP_PropertyTax -- an owned property costs its owner money every few minutes, taken from his bank, or owed until he pays it by hand; a property that is not paid is taken back
// (docs\APOLLO_RP.txt, section 11; ORIGIN.txt items 42, 44 and 45).
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
//
// PAYMENT BY HAND (arp_h9_tax_manual 1; with 0 the tax is everything above and nothing of this). The toll takes nothing from a bank by itself: what each owned property costs at it is added to what THAT
// PROPERTY OWES (its tax due), and the number of tolls it has owed in a row counts up. A property owes ONE tax and is taken back as ONE, whatever its number of doors (the doors of
// a building are bound to its property by name in arp_doors, so clearing the owner clears them all). What a property owes lives in memory and in a table of its own, arp_h9_taxdue:
// one row for each property, keyed like arp_h9_taxbase by the map's property table and the property's internal name, with its owner's key, the due, the tolls, whether it pays
// automatically, and the lock it had before it was first bought. A row whose owner is not the property's owner of the moment (a sale, a gift, an admin's change of owner) starts
// again, so one owner's debt, and his automatic payment, are never the next one's. A property that costs nothing at a toll (no price to count and a flat sum of 0) owes nothing.
// The owner pays by hand: the chat command /renew (also /paytax) while he looks at a door of the property (the crosshair test of /sell and /lock; any door of it gives the property)
// opens ONE menu for that property: its tax at a toll, what it owes, its tolls and how long it has before it is taken back, his bank and wallet, 1. pay what it owes (from the bank,
// the rest from the wallet), 2. automatic payment on or off, 0. close. It is an H9 panel on a game that draws them and the classic text menu on any other (ApolloRP_VGui.inc,
// arp_h9_vgui). A door that is not his property, or nothing, gets a line and what he owes in all, as say /tax lists it.
//
// AUTOMATIC PAYMENT is an opt-in for each property, the second key of the menu. At each toll a property that has it is charged, from its owner's bank, what it owes plus this toll's
// amount, all or nothing for each owner (the sum of his automatic properties). An owner in the game whose character has loaded is charged in the bank in memory when it holds
// the sum, and told in one [ARP] line. An owner who is away is charged by ONE statement, UPDATE <users table> SET bankmoney=bankmoney-N WHERE <his key> AND bankmoney>=N, and its callback
// reads SQL_AffectedRows, so that it knows whether it went through without a race and without a read first; what it took goes in his row of arp_h9_tax for the popup he is shown
// when he is back. What could not be taken becomes tax due on those properties exactly as for a property paid by hand.
//
// EVICTION BY THE SERVER (arp_h9_tax_evict 1; it needs something that can owe, so it means something only with arp_h9_tax_manual 1). At a toll a property is taken back when it has owed
// for arp_h9_tax_evict_tolls tolls in a row (0: no such limit) or when what it owes has reached arp_h9_tax_evict_debt (0: no such limit): either one. It is the server's own act: the
// owner need not be in the game. Taking it back clears its owner's name and key and its keyholders (ARP_PropertyClearAccess), sets its price back to what the owner paid
// (arp_h9_taxbase; a property with no such record keeps its price), sets its lock back to what it was before it was first bought (noted at the event Property_Buy when the property had
// no owner; sealed where that is not known), deletes its row, and writes one log line. Its profit stays with it, as at any sale (but see THE TOWN'S TREASURY, below). The ex-owner is told at once when he is in the game
// and his character has loaded, and in his next login popup when not (a row of arp_h9_taxnote, deleted with the showing). An owner in the game is warned in one line when a property
// passes half and three quarters of its allowance, and his login popup says how long each of his properties has left. Nothing is taken back in the first toll after the map began
// (the clock starts with the map), nor while the database cannot be used (the ex-owner's notice is written to it: the property goes at a later toll), and a toll waits until what each
// property owes has been read from the database.
//
// THE TOWN'S TREASURY (arp_h9_tax_treasury 1; it means something only with arp_h9_tax_manual 1 and arp_h9_tax_evict 1, since nothing is taken back without them). The profit of a property that is
// taken back (ARP_PropertyGetProfit: the share of every sale that the shops of npcs.ini naming it have added to it, ARP_NPCs) is added to the treasury of the town the property is in, and the
// property's profit is set to 0, in the same step. A town is a key of a few letters: on h9_tsrp_hive the three cities, by the prefix of the property's internal name (h9_al_ al, h9_pc_ pc,
// h9_xe_ xe; h9_jail, the property of the jail of Alexandria, is Alexandria's), on every other map the whole map (all). The treasury belongs to the town: one row for each map's property table and
// town in the table arp_h9_treasury (tbl, town, faction, balance), made with CREATE TABLE IF NOT EXISTS only while the cvar is 1. The faction is who runs the town (msr until a row says ins);
// nothing here changes it, and it does not touch the balance. The balance counts in whole numbers, never past TAX_MAX_TREASURY, and is added to by statements that wait. THE ORDER: the database
// is written first, and the property's profit is set to 0 only when the statement says that the sum was added, so a database that cannot be written, a treasury that cannot hold the sum
// and a property that is in no town of its map leave the profit with the property (the log says so): a sum is never in neither place. ARP writes a property's profit only at its own save
// (arp_save_interval seconds, or a map change) while the treasury is written at once: a server that dies in those seconds restarts with the property as ARP last saved it, owned and with its
// profit, and the sum is then in both places, a duplicate and never a loss (the log line of the eviction names the sum). A property with no profit credits nothing and writes nothing.
// Nothing in this plugin takes money out of a treasury.
//
// The tables are made with CREATE TABLE IF NOT EXISTS when they are first needed (the two of payment by hand only while arp_h9_tax_manual is 1, the treasury's only while arp_h9_tax_treasury is 1);
// going back is dropping them.

#pragma dynamic 8192

#define TAX_OWNERS       160     // owners one toll holds; the properties of any beyond them are left out (the log says so)
#define TAX_BASES        256     // properties whose price at the sale is kept in memory
#define TAX_KEY_FULL     35      // the characters of an H9XASH authid ("ID_" and 32 digits), which is a character's key
#define TAX_KEY_CUT      32      // the fewest characters of a cut key that a property row saved before the core kept whole keys can hold (see tax_cut)
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
#define TAX_ROWS         256     // properties whose tax due, automatic payment or lock before the first sale are kept in memory
#define TAX_MAX_DUE      1000000000 // the most one property can owe
#define TAX_MAX_TOLLS    1000000 // the most tolls one property can have owed in a row, and the most arp_h9_tax_evict_tolls counts
#define TAX_MAX_LIMIT    100000000 // the most arp_h9_tax_evict_debt counts
#define TAX_QUEUE        48      // warnings and properties taken back that a pass holds before it tells their owners
#define TAX_NOTE_ROWS    20      // notices of properties taken back that a login reads at most
#define TAX_PEND_SECS    120.0   // seconds an automatic payment may wait for the database before a toll says so in the log (it is never given up: its statement is still queued)
#define TAX_MENU_PANEL   "arptax.pay"
#define TAX_MAX_TREASURY 2000000000 // the most a town's treasury holds
#define TAX_TOWNS        3       // the towns of h9_tsrp_hive
#define TAX_TOWN_LEN     8       // characters of a town's key

// the kinds of query whose answer TaxDbDone is given
#define TAX_Q_RECORD     1
#define TAX_Q_BANK       2
#define TAX_Q_PRICE      3
#define TAX_Q_ROW        4
#define TAX_Q_AUTO       5
#define TAX_Q_NOTE       6

// the kinds of notice an owner is sent (tax_notice_add)
#define TAX_N_WARN       1
#define TAX_N_GONE       2

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

// the statements of payment by hand: what each property owes and the notices of properties taken back (the notice names its owner by the key the users table keeps, so a cut key finds him)
#define TAX_SQL_DUE_SQLITE     "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),name VARCHAR(66),ownerkey VARCHAR(36),due INT(11),tolls INT(11),autopay INT(11),locked INT(11),UNIQUE (tbl,name))"
#define TAX_SQL_DUE_MYSQL      "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),name VARCHAR(66),ownerkey VARCHAR(36),due INT(11),tolls INT(11),autopay INT(11),locked INT(11),UNIQUE KEY (tbl,name))"
#define TAX_SQL_NOTE_SQLITE    "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),tbl VARCHAR(66),name VARCHAR(66),shown VARCHAR(24),tolls INT(11),due INT(11),why INT(11),updated INT(11),UNIQUE (authid,tbl,name))"
#define TAX_SQL_NOTE_MYSQL     "CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),tbl VARCHAR(66),name VARCHAR(66),shown VARCHAR(24),tolls INT(11),due INT(11),why INT(11),updated INT(11),UNIQUE KEY (authid,tbl,name))"
#define TAX_SQL_DUE_READ       "SELECT name,ownerkey,due,tolls,autopay,locked FROM %s WHERE tbl='%s'"
#define TAX_SQL_DUE_PUT_SQLITE "INSERT OR REPLACE INTO %s (tbl,name,ownerkey,due,tolls,autopay,locked) VALUES ('%s','%s','%s',%d,%d,%d,%d)"
#define TAX_SQL_DUE_PUT_MYSQL  "REPLACE INTO %s (tbl,name,ownerkey,due,tolls,autopay,locked) VALUES ('%s','%s','%s',%d,%d,%d,%d)"
#define TAX_SQL_DUE_DEL        "DELETE FROM %s WHERE tbl='%s' AND name='%s'"
#define TAX_SQL_NOTE_PUT       "%s %s (authid,tbl,name,shown,tolls,due,why,updated) SELECT u.authid,'%s','%s','%s',%d,%d,%d,%d FROM %s u WHERE %s"
#define TAX_SQL_NOTE_READ      "SELECT shown,tolls,due,why,updated FROM %s WHERE authid='%s' ORDER BY updated LIMIT %d"
#define TAX_SQL_NOTE_CLEAR     "DELETE FROM %s WHERE authid='%s' AND updated<=%d"
#define TAX_SQL_AUTO           "UPDATE %s SET bankmoney=bankmoney-%d WHERE %s AND bankmoney>=%d"

// the statements of the towns' treasuries: one row for each map's property table and town, made when a sum is first added to it
#define TAX_SQL_TREAS_SQLITE     "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),town VARCHAR(8),faction VARCHAR(8),balance INT(11),UNIQUE (tbl,town))"
#define TAX_SQL_TREAS_MYSQL      "CREATE TABLE IF NOT EXISTS %s (tbl VARCHAR(66),town VARCHAR(8),faction VARCHAR(8),balance INT(11),UNIQUE KEY (tbl,town))"
#define TAX_SQL_TREAS_ROW_SQLITE "INSERT OR IGNORE INTO %s (tbl,town,faction,balance) VALUES ('%s','%s','msr',0)"
#define TAX_SQL_TREAS_ROW_MYSQL  "INSERT IGNORE INTO %s (tbl,town,faction,balance) VALUES ('%s','%s','msr',0)"
#define TAX_SQL_TREAS_ADD        "UPDATE %s SET balance=balance+%d WHERE tbl='%s' AND town='%s' AND balance<=%d"
#define TAX_SQL_TREAS_READ       "SELECT town,faction,balance FROM %s WHERE tbl='%s' ORDER BY town"

// the cvars
new p_Tax
new p_Minutes
new p_Percent
new p_Flat
new p_Manual                                    // arp_h9_tax_manual: 1 adds the toll to what each property owes and the owner pays by hand
new p_Evict                                     // arp_h9_tax_evict: 1 lets the server take back a property that has owed too long or too much
new p_EvictTolls                                // arp_h9_tax_evict_tolls: the tolls a property may owe in a row
new p_EvictDebt                                 // arp_h9_tax_evict_debt: the money a property may owe
new p_Treasury                                  // arp_h9_tax_treasury: 1 sends the profit of a property that is taken back to the treasury of its town

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
new g_DueTable[] = "arp_h9_taxdue"              // what each property owes (the map's property table and the property's internal name)
new g_NoteTable[64]                             // the notices of properties taken back; it follows the users table like g_TaxTable
new g_DbMade2                                   // the two tables of payment by hand are there
new g_DueInited                                 // what the properties of this map owe has been asked for
new g_DueLoaded                                 // and has come
new g_PendSeq                                   // the number of the last automatic payment that was handed to the database
new g_TreasTable[] = "arp_h9_treasury"          // the treasuries of the towns (the map's property table, the town, who runs it, what it holds)
new g_DbMade3                                   // the treasury table is there
new g_TreasSum                                  // what has gone to a treasury since the map began, and from how many properties
new g_TreasNum

// the towns of h9_tsrp_hive: the key, the prefix of the internal names of its properties, and what the command calls it
new g_TownKey[TAX_TOWNS][] = {"al","pc","xe"}
new g_TownPrefix[TAX_TOWNS][] = {"h9_al_","h9_pc_","h9_xe_"}
new g_TownName[TAX_TOWNS][] = {"Alexandria","Paradise City","Xenon City"}

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
new g_LastHand                                  // properties that owed more at the last toll of payment by hand, without paying automatically
new g_LastHandSum                               // and what they were charged in all
new g_LastShort                                 // properties whose automatic payment could not be made
new g_LastGone                                  // properties taken back at it
new g_LastWarned                                // owners warned at it
new g_Gone                                      // properties taken back since the map began

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
new g_Note[MAX_PLAYERS + 1]                     // 0 nothing, 1 his notices of properties taken back have been asked for, 2 they are in hand and he is to be shown them
new g_NoteNum[MAX_PLAYERS + 1]
new g_NoteName[MAX_PLAYERS + 1][TAX_NAMES][TAX_NAME_SHOWN + 4]
new g_NoteStamp[MAX_PLAYERS + 1]
new g_Dues[MAX_PLAYERS + 1]                     // 1: he is to be told what his properties owe and how long they have, with the rest
new g_MenuProp[MAX_PLAYERS + 1][66]             // the internal name of the property whose menu he has open ("" none)
new g_MenuName[] = "ARP_PropertyTaxMenu"

// what each property owes (arp_h9_taxdue): its internal name, its owner's key as the core gave it, the money, the tolls owed in a row, whether it pays automatically, and the lock it had
// before it was first bought (-1 not known)
new g_RowName[TAX_ROWS][66]
new g_RowOwner[TAX_ROWS][36]
new g_RowDue[TAX_ROWS]
new g_RowTolls[TAX_ROWS]
new g_RowAuto[TAX_ROWS]
new g_RowLock[TAX_ROWS]
new g_RowDirty[TAX_ROWS]                        // 1: to be written to the database, 2: to be deleted from it, 3: its delete is on its way (the place of the row is free when the database says it is gone)
new g_RowPend[TAX_ROWS]                         // the number of the automatic payment of an owner who is away that is on its way to the database (0 none)
new Float:g_RowPendAt[TAX_ROWS]
new g_RowAmt[TAX_ROWS]                          // what this toll costs the property, while its automatic payment is being worked out
new g_RowBefore[TAX_ROWS]                       // how far through its allowance it was before this toll
new g_RowSlot[TAX_ROWS]                         // its owner's place in this toll, plus 1
new g_RowSerial[TAX_ROWS]                       // the number of the statement that deletes this row while one is on its way: only its answer frees the place of the row
new g_RowSeq                                    // the number of the last such statement
new g_RowNum

// the warnings and the properties taken back that a pass has to tell their owners (tax_notice_flush)
new g_NtKind[TAX_QUEUE]
new g_NtProp[TAX_QUEUE]
new g_NtKey[TAX_QUEUE][36]
new g_NtTolls[TAX_QUEUE]
new g_NtDue[TAX_QUEUE]
new g_NtWhy[TAX_QUEUE]
new g_NtLeft[TAX_QUEUE]
new g_NtNum

// ---------------------------------------------------------------------------------------------------------------------- start

public ARP_Init()
{
	ARP_RegisterPlugin("PropertyTax",ARP_VERSION,"H9","Charges a property tax to the owner of every property (from his bank, or paid by hand) and takes back a property that is not paid")

	ARP_RegisterEvent("Player_Ready","EventReady")
	ARP_RegisterEvent("Property_Buy","EventPropertyBuy")
}

public plugin_precache()
	arpvgui_precache()

public plugin_init()
{
	arpvgui_init("arptax")

	// arp_h9_tax is the switch (0: stock Apollo RP); a toll comes every arp_h9_tax_minutes minutes and takes arp_h9_tax_flat plus arp_h9_tax_percent per cent of what each property cost,
	// from its owner's bank
	p_Tax = register_cvar("arp_h9_tax","1")
	p_Minutes = register_cvar("arp_h9_tax_minutes","15")
	p_Percent = register_cvar("arp_h9_tax_percent","1.0")
	p_Flat = register_cvar("arp_h9_tax_flat","0")

	// arp_h9_tax_manual 1: the toll adds to what each property owes and the owner pays by hand (/renew, with an opt-in for automatic payment); arp_h9_tax_evict 1: the server takes back a
	// property that has owed for arp_h9_tax_evict_tolls tolls in a row or arp_h9_tax_evict_debt money. 0 and 0 charge every owner's bank at each toll and take nothing back
	p_Manual = register_cvar("arp_h9_tax_manual","0")
	p_Evict = register_cvar("arp_h9_tax_evict","0")
	p_EvictTolls = register_cvar("arp_h9_tax_evict_tolls","96")
	p_EvictDebt = register_cvar("arp_h9_tax_evict_debt","0")

	// arp_h9_tax_treasury 1: the profit of a property that is taken back goes to the treasury of its town (the table arp_h9_treasury) in place of staying with the property; it needs
	// arp_h9_tax_manual 1 and arp_h9_tax_evict 1. 0 (the default): the profit stays with the property, and the table is never made
	p_Treasury = register_cvar("arp_h9_tax_treasury","0")

	ARP_RegisterChat("/tax","SayTax","- shows what your properties cost in property tax at each toll, what they owe, and when the next toll is")
	ARP_RegisterChat("/renew","SayRenew","- the property tax of the property whose door you look at: a menu to pay what it owes, and to turn its automatic payment on or off")
	ARP_RegisterChat("/paytax","SayPayTax","- the same as /renew")

	ARP_AddCommand("arp_h9_tax_dump","(ADMIN) Shows the property tax: its switches, its clock, the last toll and the database")
	register_concmd("arp_h9_tax_dump","CmdDump",_,"- the property tax: switches, clock, the last toll, the database")
	ARP_AddCommand("arp_h9_tax_value","(ADMIN) <internal name> <price> - the price a property counts as having cost, which the percent of the tax is taken of")
	register_concmd("arp_h9_tax_value","CmdValue",_,"<internal name> <price> - the price a property counts as having cost (0: its own price again)")
	ARP_AddCommand("arp_h9_tax_towns","(ADMIN) Shows the towns of this map: each one's key, who runs it and what its treasury holds")
	register_concmd("arp_h9_tax_towns","CmdTowns",_,"- the towns of this map: key, faction, treasury")

	register_menucmd(register_menuid(g_MenuName),MENU_KEY_1|MENU_KEY_2|MENU_KEY_0,"TaxMenuHandle")

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
	g_Note[id] = 0
	g_NoteNum[id] = 0
	g_Dues[id] = 0
	g_MenuProp[id][0] = 0
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

// whether the text of an owner's key is a character's key that has been cut. H9XASH's authids are 35 characters ("ID_" and 32 digits). The core's two natives for an owner's key keep all of them
// (ARP_PropertyGetOwnerAuth and ARP_PropertySetOwnerAuth, ORIGIN item 42), but a property row saved while stock ARP cut them to 33 and 32 is still read as it was saved: so an owner's key of 32, 33
// or 34 characters is the beginning of the key of a character, and the other keys (a Steam id has fewer than 32 characters) are whole.
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

// names as a list: "A", "A and B", "A, B and C", and "A, B, C and 4 more" past TAX_NAMES (n names in all, the first `shown` of them in nm)
stock tax_join(const nm[][TAX_NAME_SHOWN + 4],shown,n,out[],len)
{
	new used

	out[0] = 0

	for(new i;i < shown;i++)
	{
		if(i > 0 && i == shown - 1 && n == shown)
			used += formatex(out[used],len - used," and ")
		else if(i > 0)
			used += formatex(out[used],len - used,", ")

		used += formatex(out[used],len - used,"%s",nm[i])
	}

	if(n > shown)
		formatex(out[used],len - used," and %d more",n - shown)
}

// n properties (the numbers of the first few in props) as a list of their names
stock tax_names_of(const props[],n,out[],len)
{
	static nm[TAX_NAMES][TAX_NAME_SHOWN + 4]
	new shown = min(n,TAX_NAMES)

	for(new i;i < shown;i++)
		tax_prop_name(props[i],nm[i],TAX_NAME_SHOWN + 3)

	tax_join(nm,shown,n,out,len)
}

// the properties of an owner of this toll as a list
stock tax_names(o,out[],len)
	tax_names_of(g_OwnShown[o],g_OwnProps[o],out,len)

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

// the table names, once: the users table and the property table of the map, and the record table and the notice table that go with the users table (its name's letters, digits and
// underscores)
stock tax_tables()
{
	ARP_GetTable(USERS,g_UsersTable,63)
	ARP_GetTable(PROPERTIES,g_PropTable,63)

	copy(g_TaxTable,63,"arp_h9_tax")

	if(equali(g_UsersTable,"arp_users"))
	{
		copy(g_NoteTable,63,"arp_h9_taxnote")

		return
	}

	new n = strlen(g_TaxTable)
	g_TaxTable[n++] = '_'

	for(new i;g_UsersTable[i] && n < 63;i++)
	{
		new c = g_UsersTable[i]
		if((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')
			g_TaxTable[n++] = c
	}

	g_TaxTable[n] = 0
	formatex(g_NoteTable,63,"arp_h9_taxnote%s",g_TaxTable[10])
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
		case TAX_Q_ROW:
			copy(what,95,"row of what a property owes")
		case TAX_Q_NOTE:
			copy(what,95,"notice of a property taken back")
		default:
			copy(what,95,"price")
	}

	tax_db_fail(what,error)

	if(data[0] == TAX_Q_ROW)
		tax_rows_redo()

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

	if(tax_by_hand())
		tax_lock_note(property)

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

// ---------------------------------------------------------------------------------------------------------------------- payment by hand: the switches and what a property owes

// whether the tax is paid by hand: it is on, and its tolls add to what each property owes (but for the properties that pay automatically) instead of taking money from a bank
stock bool:tax_by_hand()
	return get_pcvar_num(p_Tax) != 0 && get_pcvar_num(p_Manual) != 0

// whether the server takes back a property that has owed too long or too much
stock bool:tax_evicts()
	return tax_by_hand() && get_pcvar_num(p_Evict) != 0

// the tolls a property may owe in a row before it is taken back (0: no such limit)
stock tax_limit_tolls()
	return clamp(get_pcvar_num(p_EvictTolls),0,TAX_MAX_TOLLS)

// the money a property may owe before it is taken back (0: no such limit)
stock tax_limit_debt()
	return clamp(get_pcvar_num(p_EvictDebt),0,TAX_MAX_LIMIT)

// a sum of money that never passes what 32 bits hold: a + b, or 2000000000 (b is at most TAX_MAX_DUE)
stock tax_add(a,b)
	return a > 2000000000 - b ? 2000000000 : a + b

// how far a property is through its allowance: 0 below half of it, 1 from half, 2 from three quarters, 3 when it is used up (the period and the ceiling count alike: the further one wins);
// 0 when the server takes nothing back. Whole numbers are compared and nothing is multiplied, so no sum passes 32 bits.
stock tax_level(tolls,due)
{
	if(!tax_evicts())
		return 0

	new lt = tax_limit_tolls(),ld = tax_limit_debt(),lvl,v

	if(lt > 0)
		lvl = tolls >= lt ? 3 : (tolls >= lt - lt / 4 ? 2 : (tolls >= lt - lt / 2 ? 1 : 0))

	if(ld > 0)
	{
		v = due >= ld ? 3 : (due >= ld - ld / 4 ? 2 : (due >= ld - ld / 2 ? 1 : 0))

		if(v > lvl)
			lvl = v
	}

	return lvl
}

// the tolls a property has left before it is taken back, counting the next one (so at least 1), or -1 when nothing is taken back: the fewer of what the period and the ceiling leave,
// the ceiling by what a toll adds
stock tax_left_tolls(tolls,due,amount)
{
	if(!tax_evicts())
		return -1

	new lt = tax_limit_tolls(),ld = tax_limit_debt(),left = -1,v

	if(lt > 0)
		left = max(lt - tolls,1)

	if(ld > 0 && amount > 0)
	{
		v = due >= ld ? 1 : max((ld - due + amount - 1) / amount,1)

		if(left < 0 || v < left)
			left = v
	}

	return left
}

// the seconds before a property with `left` tolls to go is taken back: the time to the next toll, and then an interval for each toll after it
stock Float:tax_secs_left(left)
{
	new Float:interval = tax_minutes() * 60.0,Float:next = g_NextToll > 0.0 ? g_NextToll - get_gametime() : interval

	if(next < 0.0)
		next = 0.0

	return next + float(max(left - 1,0)) * interval
}

// "less than an hour", "about 1 hour", "about 18 hours", "about 3 days"
stock tax_time_text(Float:seconds,out[],len)
{
	new hours = floatround(seconds / 3600.0)

	if(seconds < 3600.0)
		copy(out,len,"less than an hour")
	else if(hours < 2)
		copy(out,len,"about 1 hour")
	else if(hours < 72)
		formatex(out,len,"about %d hours",hours)
	else
		formatex(out,len,"about %d days",floatround(seconds / 86400.0))
}

// the players in the game and the key of each (g_PKey)
stock tax_scan(players[MAX_PLAYERS],&num)
{
	get_players(players,num,"ch")

	for(new i;i < num;i++)
		tax_key(players[i],g_PKey[players[i]],35)
}

// ---------------------------------------------------------------------------------------------------------------------- payment by hand: the rows

stock tax_row_find(const name[])
{
	for(new r;r < g_RowNum;r++)
		if(g_RowName[r][0] && equali(g_RowName[r],name))
			return r

	return -1
}

// a row that holds nothing
stock tax_row_blank(r)
{
	g_RowOwner[r][0] = 0
	g_RowDue[r] = 0
	g_RowTolls[r] = 0
	g_RowAuto[r] = 0
	g_RowLock[r] = -1
	g_RowDirty[r] = 0
	g_RowPend[r] = 0
	g_RowAmt[r] = 0
	g_RowBefore[r] = 0
	g_RowSlot[r] = 0
	g_RowSerial[r] = 0
}

// the row of a property, made when there is none (-1 when the table is full)
stock tax_row_make(const name[])
{
	new r = tax_row_find(name)

	if(r >= 0)
		return r

	for(r = 0;r < g_RowNum;r++)
		if(!g_RowName[r][0])
			break

	if(r >= TAX_ROWS)
		return -1

	if(r == g_RowNum)
		g_RowNum++

	copy(g_RowName[r],65,name)
	tax_row_blank(r)

	return r
}

// whether a row holds anything worth keeping
stock bool:tax_row_empty(r)
	return g_RowDue[r] == 0 && g_RowTolls[r] == 0 && g_RowAuto[r] == 0 && g_RowLock[r] < 0

// a row changed: it is written to the database, or deleted from it when it holds nothing any more
stock tax_row_touch(r)
	g_RowDirty[r] = tax_row_empty(r) ? 2 : 1

// the row of a property that has this owner, made when there is none. A row that was made for another owner starts again (what it owed and its automatic payment end with a sale, a gift
// or an admin's change of owner, so one owner's debt is never the next one's), keeping the lock it noted; of the texts of one owner's key the longest is kept.
stock tax_row_for(property,const owner[])
{
	new name[66],r

	ARP_PropertyGetInternalName(property,name,65)
	r = tax_row_make(name)

	if(r < 0)
		return -1

	if(!g_RowOwner[r][0])
		copy(g_RowOwner[r],35,owner)
	else if(!tax_same(g_RowOwner[r],owner))
	{
		g_RowDue[r] = 0
		g_RowTolls[r] = 0
		g_RowAuto[r] = 0
		g_RowPend[r] = 0
		g_RowSlot[r] = 0
		copy(g_RowOwner[r],35,owner)
		tax_row_touch(r)
	}
	else if(strlen(owner) > strlen(g_RowOwner[r]))
		copy(g_RowOwner[r],35,owner)

	return r
}

// the row of a property that has this owner, if there is one (-1 for none: a row of another owner is not his)
stock tax_row_peek(property,const owner[])
{
	new name[66],r

	ARP_PropertyGetInternalName(property,name,65)
	r = tax_row_find(name)

	if(r < 0 || (g_RowOwner[r][0] && !tax_same(g_RowOwner[r],owner)))
		return -1

	return r
}

// the property of a row (0 when it is gone)
stock tax_row_property(r)
	return ARP_PropertyMatch(_,_,g_RowName[r])

// whether the owner of a property is still the one its row was made for: a sale, or an admin's change of owner, since says no. A payment that is on its way to the database when that happens is
// answered afterwards (TaxDbAuto), and by then the property is its new owner's: nothing is charged to him, and nothing may be taken back from him, for what the old owner owed.
stock bool:tax_row_owned(r,property)
{
	new owner[36]

	if(!ARP_ValidProperty(property))
		return false

	ARP_PropertyGetOwnerAuth(property,owner,35)

	return owner[0] != 0 && g_RowOwner[r][0] != 0 && tax_same(owner,g_RowOwner[r])
}

// the row of a property that has changed hands since a payment was sent: it starts again for the owner the property has now, as tax_row_for makes a row start again at a toll
stock tax_row_orphan(r,property)
{
	new owner[36]

	if(ARP_ValidProperty(property))
		ARP_PropertyGetOwnerAuth(property,owner,35)

	g_RowDue[r] = 0
	g_RowTolls[r] = 0
	g_RowAuto[r] = 0
	g_RowPend[r] = 0
	g_RowSlot[r] = 0
	copy(g_RowOwner[r],35,owner)
	tax_row_touch(r)
}

// what a toll adds to a property: its due, and one toll more owed in a row
stock tax_row_accrue(r,amount)
{
	g_RowDue[r] = min(g_RowDue[r] + amount,TAX_MAX_DUE)
	g_RowTolls[r] = min(g_RowTolls[r] + 1,TAX_MAX_TOLLS)
	tax_row_touch(r)
}

// a property is paid up
stock tax_row_paid(r)
{
	g_RowDue[r] = 0
	g_RowTolls[r] = 0
	tax_row_touch(r)
}

// the lock a property had before it was first bought, kept to give back when it is taken back. It is noted when a property that has no owner is bought: a property bought from another
// player has been locked or unlocked by him, and what was noted before stays.
stock tax_lock_note(property)
{
	new owner[36],name[66],r

	ARP_PropertyGetOwnerAuth(property,owner,35)

	if(owner[0])
		return

	ARP_PropertyGetInternalName(property,name,65)
	r = tax_row_make(name)

	if(r < 0)
	{
		log_amx("[ARP] property tax: more than %d properties are kept; the lock of %s is not noted",TAX_ROWS,name)

		return
	}

	// a property that has no owner owes nothing: what an earlier owner left in its row is dropped
	g_RowDue[r] = 0
	g_RowTolls[r] = 0
	g_RowAuto[r] = 0
	g_RowPend[r] = 0
	g_RowOwner[r][0] = 0
	g_RowLock[r] = ARP_PropertyGetLocked(property) ? 1 : 0
	tax_row_touch(r)
}

// ---------------------------------------------------------------------------------------------------------------------- payment by hand: the database

// whether the two tables of payment by hand are there (made once, with queries that wait, like the others)
stock bool:tax_db_table2()
{
	if(g_DbMade2)
		return true

	new err,msg[128],Handle:db = SQL_Connect(ARP_SqlHandle(),err,msg,127)
	if(db == Empty_Handle || err)
	{
		tax_db_fail("connect",msg)

		return false
	}

	new query[300],bool:ok

	if(ARP_SqlMode() == MYSQL)
		formatex(query,299,TAX_SQL_DUE_MYSQL,g_DueTable)
	else
		formatex(query,299,TAX_SQL_DUE_SQLITE,g_DueTable)

	ok = tax_exec(db,query,msg,127) >= 0

	if(ok)
	{
		if(ARP_SqlMode() == MYSQL)
			formatex(query,299,TAX_SQL_NOTE_MYSQL,g_NoteTable)
		else
			formatex(query,299,TAX_SQL_NOTE_SQLITE,g_NoteTable)

		ok = tax_exec(db,query,msg,127) >= 0
	}

	SQL_FreeHandle(db)

	if(!ok)
	{
		tax_db_fail("create",msg)

		return false
	}

	g_DbMade2 = 1

	return true
}

// whether the database may be read and written now, with the tables of payment by hand as well
stock bool:tax_db_ready2()
{
	if(!tax_db_ready())
		return false

	return tax_db_table2()
}

// what the properties of this map owe is asked for, once the database is up (payment by hand only): the toll waits for it
stock tax_init_dues()
{
	if(g_DueInited || ARP_SqlHandle() == Empty_Handle || !tax_db_ready2())
		return

	new tbl[140],query[300],data[1]

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	formatex(query,299,TAX_SQL_DUE_READ,g_DueTable,tbl)

	data[0] = TAX_Q_ROW
	g_DueInited = 1
	g_DueLoaded = 0
	g_DbReads++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDues",query,data,1)
}

// the answer: the rows are added to what memory has (a row made or changed since the map began is fresher than the table's)
public TaxDbDues(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused data,size,queuetime

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		tax_db_fail("what the properties owe",error)
		g_DueInited = 0

		return PLUGIN_CONTINUE
	}

	new name[66],owner[40],r

	while(SQL_MoreResults(query))
	{
		SQL_ReadResult(query,0,name,65)

		if(tax_row_find(name) < 0)
		{
			r = tax_row_make(name)

			if(r >= 0)
			{
				SQL_ReadResult(query,1,owner,35)
				copy(g_RowOwner[r],35,owner)
				g_RowDue[r] = SQL_ReadResult(query,2)
				g_RowTolls[r] = SQL_ReadResult(query,3)
				g_RowAuto[r] = SQL_ReadResult(query,4) ? 1 : 0
				g_RowLock[r] = SQL_ReadResult(query,5)
			}
			else
				log_amx("[ARP] property tax: more than %d properties are kept; what %s owes is not read",TAX_ROWS,name)
		}

		SQL_NextRow(query)
	}

	g_DueLoaded = 1

	return PLUGIN_CONTINUE
}

// the rows that changed go to the database, a statement for each. A row that holds nothing any more is deleted, and its place is free again only when the database has said that the row is gone
// (TaxDbRowGone): a delete that fails is sent again with every other row, so that a debt that was paid is not left in the table while the map lasts (a map change before it is sent again leaves it
// there, and it is read back at the next map). Nothing is sent while the database may not be used, and the beat
// tries again, so that a row is written in the end. The row of an automatic payment that is on its way waits for its answer.
stock tax_rows_flush()
{
	new r,any

	for(r = 0;r < g_RowNum;r++)
		if(g_RowName[r][0] && (g_RowDirty[r] == 1 || g_RowDirty[r] == 2) && !g_RowPend[r])
		{
			any = 1

			break
		}

	if(!any || !tax_db_ready2())
		return

	static query[500],tbl[140],nm[140],ow[72]
	new data[1],gone[2]

	data[0] = TAX_Q_ROW
	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)

	for(r = 0;r < g_RowNum;r++)
	{
		if(!g_RowName[r][0] || (g_RowDirty[r] != 1 && g_RowDirty[r] != 2) || g_RowPend[r])
			continue

		copy(nm,139,g_RowName[r])
		ARP_SqlEscape(nm,139)

		if(g_RowDirty[r] == 2)
		{
			formatex(query,499,TAX_SQL_DUE_DEL,g_DueTable,tbl,nm)

			g_RowDirty[r] = 3
			g_RowSerial[r] = ++g_RowSeq
			gone[0] = r
			gone[1] = g_RowSerial[r]
			g_DbWrites++

			ARP_CleverQuery(ARP_SqlHandle(),"TaxDbRowGone",query,gone,2)

			continue
		}
		else
		{
			copy(ow,71,g_RowOwner[r])
			ARP_SqlEscape(ow,71)

			if(ARP_SqlMode() == MYSQL)
				formatex(query,499,TAX_SQL_DUE_PUT_MYSQL,g_DueTable,tbl,nm,ow,g_RowDue[r],g_RowTolls[r],g_RowAuto[r],g_RowLock[r])
			else
				formatex(query,499,TAX_SQL_DUE_PUT_SQLITE,g_DueTable,tbl,nm,ow,g_RowDue[r],g_RowTolls[r],g_RowAuto[r],g_RowLock[r])

			g_RowDirty[r] = 0
		}

		g_DbWrites++

		ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,1)
	}
}

// a statement for a row failed: every row is written again (or deleted, when it holds nothing) as soon as the database may be used
stock tax_rows_redo()
{
	for(new r;r < g_RowNum;r++)
		if(g_RowName[r][0])
			tax_row_touch(r)
}

// the answer to the delete of a row that holds nothing: the row is gone from the database, and its place is free again, unless the row has been changed or its delete sent again since (the number of
// the statement says which one this answers). A delete that failed leaves the row where it is, and every row is written or deleted again as soon as the database may be used.
public TaxDbRowGone(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused query,size,queuetime

	new r = data[0]

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		tax_db_fail("row of what a property owes",error)
		tax_rows_redo()

		return PLUGIN_CONTINUE
	}

	if(r >= 0 && r < g_RowNum && g_RowName[r][0] && g_RowDirty[r] == 3 && g_RowSerial[r] == data[1])
	{
		g_RowName[r][0] = 0
		tax_row_blank(r)
	}

	return PLUGIN_CONTINUE
}

// a notice for a character who is not in the game: one row for each property taken back, under the key the users table keeps him under (a character that has no row there is not written
// for), deleted when he is shown it
stock tax_note_put(const owner[],property,tolls,due,why)
{
	if(!tax_db_ready2())
		return

	static query[900],condU[160],tbl[140],nm[140],shown[48],verb[24]
	new raw[66],data[1]

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	ARP_PropertyGetInternalName(property,raw,65)
	copy(nm,139,raw)
	ARP_SqlEscape(nm,139)
	tax_prop_name(property,shown,TAX_NAME_SHOWN + 3)
	ARP_SqlEscape(shown,47)
	tax_key_cond("u.authid",owner,condU,159)

	if(ARP_SqlMode() == MYSQL)
		copy(verb,23,"REPLACE INTO")
	else
		copy(verb,23,"INSERT OR REPLACE INTO")

	formatex(query,899,TAX_SQL_NOTE_PUT,verb,g_NoteTable,tbl,nm,shown,tolls,due,why,get_systime(),g_UsersTable,condU)
	data[0] = TAX_Q_NOTE
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,1)
}

// ---------------------------------------------------------------------------------------------------------------------- payment by hand: warnings and eviction

// a property is to be told to its owner: a warning that it has passed half or three quarters of its allowance, or that it was taken back (sent by tax_notice_flush)
stock tax_notice_add(kind,property,const owner[],tolls,due,why,left)
{
	if(g_NtNum >= TAX_QUEUE)
		tax_notice_flush()

	new i = g_NtNum++

	g_NtKind[i] = kind
	g_NtProp[i] = property
	copy(g_NtKey[i],35,owner)
	g_NtTolls[i] = tolls
	g_NtDue[i] = due
	g_NtWhy[i] = why
	g_NtLeft[i] = left
}

// the line that warns an owner of what a property owes and how long it has: "[ARP] Property tax: Flat A1 owes $1152. You must pay it (say /renew at its door) within about 12 hours, or
// the server takes it back." Its properties are named, or counted when the names would make the line too long for a popup.
stock tax_line_warn(const props[],count,due,left,line[],len)
{
	new names[100],time[40]

	tax_time_text(tax_secs_left(left > 0 ? left : 1),time,39)
	tax_names_of(props,count,names,99)
	tax_line_warn_text(names,count,due,time,line,len)

	if(strlen(line) > TAX_LINE_MAX)
	{
		formatex(names,99,"%d propert%s",count,count == 1 ? "y" : "ies")
		tax_line_warn_text(names,count,due,time,line,len)
	}
}

stock tax_line_warn_text(const names[],count,due,const time[],line[],len)
{
	if(count == 1)
		formatex(line,len,"[ARP] Property tax: %s owes $%d. You must pay it (say /renew at its door) within %s, or the server takes it back.",names,due,time)
	else
		formatex(line,len,"[ARP] Property tax: %s owe $%d in all. You must pay them (say /renew at each door) within %s, or the server takes the first back.",names,due,time)
}

// "[ARP] The server has taken back Flat A1: its property tax was not paid, so you do not own it any more." (away: "While you were away, the server took back Flat A1 and Shop A3: their property
// tax was not paid, so you do not own them any more.") "do not" is one of the words that give a popup the warm colour
stock tax_line_gone_text(const names[],count,bool:away,line[],len)
{
	if(away)
		formatex(line,len,"[ARP] While you were away, the server took back %s: %s property tax was not paid, so you do not own %s any more.",names,count == 1 ? "its" : "their",count == 1 ? "it" : "them")
	else
		formatex(line,len,"[ARP] The server has taken back %s: %s property tax was not paid, so you do not own %s any more.",names,count == 1 ? "its" : "their",count == 1 ? "it" : "them")
}

// the warnings and the properties taken back that a pass has gathered are told to their owners, one line for each owner and kind. An owner in the game whose character has loaded is told at
// once. A property taken back from anybody else is left as a notice for his next login (a row of arp_h9_taxnote for each property); a warning to him is dropped, because his login popup says
// how long each of his properties has left.
stock tax_notice_flush()
{
	if(g_NtNum < 1)
		return

	new players[MAX_PLAYERS],num,n = g_NtNum,done[TAX_QUEUE],members[TAX_QUEUE],props[TAX_NAMES],count,id,i,j,kind,sumDue,left,names[100]
	static line[192]

	g_NtNum = 0
	tax_scan(players,num)

	for(i = 0;i < n;i++)
	{
		if(done[i])
			continue

		kind = g_NtKind[i]
		count = 0
		sumDue = 0
		left = -1

		for(j = i;j < n;j++)
		{
			if(done[j] || g_NtKind[j] != kind || !tax_same(g_NtKey[j],g_NtKey[i]))
				continue

			done[j] = 1
			members[count] = j

			if(count < TAX_NAMES)
				props[count] = g_NtProp[j]

			count++
			sumDue = tax_add(sumDue,g_NtDue[j])

			if(g_NtLeft[j] > 0 && (left < 0 || g_NtLeft[j] < left))
				left = g_NtLeft[j]
		}

		id = tax_online(g_NtKey[i],players,num)

		if(id && !ARP_PlayerReady(id))
			id = 0

		if(kind == TAX_N_WARN)
		{
			if(id)
			{
				tax_line_warn(props,count,sumDue,left,line,191)
				client_print(id,print_chat,"%s",line)
				g_LastWarned++
			}

			continue
		}

		if(!id)
		{
			for(j = 0;j < count;j++)
				tax_note_put(g_NtKey[members[j]],g_NtProp[members[j]],g_NtTolls[members[j]],g_NtDue[members[j]],g_NtWhy[members[j]])

			continue
		}

		tax_names_of(props,count,names,99)
		tax_line_gone_text(names,count,false,line,191)

		if(strlen(line) > TAX_LINE_MAX)
		{
			formatex(names,99,"%d propert%s",count,count == 1 ? "y" : "ies")
			tax_line_gone_text(names,count,false,line,191)
		}

		client_print(id,print_chat,"%s",line)
	}
}

// ---------------------------------------------------------------------------------------------------------------------- the towns' treasuries

// whether the profit of a property that is taken back goes to a treasury: the cvar is on, and the server takes properties back
stock bool:tax_treasury()
	return tax_evicts() && get_pcvar_num(p_Treasury) != 0

// whether this map is h9_tsrp_hive, the one map that has more than one town
stock bool:tax_hive()
{
	new map[32]

	get_mapname(map,31)

	return equali(map,"h9_tsrp_hive") != 0
}

// the key of the town a property is in: on h9_tsrp_hive the city that the prefix of its internal name says (h9_jail, the property of the jail of Alexandria, is Alexandria's), on every other
// map the whole map (all). False for a property of h9_tsrp_hive that is in none.
stock bool:tax_town(property,key[],len)
{
	new name[66]

	key[0] = 0

	if(!tax_hive())
	{
		copy(key,len,"all")

		return true
	}

	ARP_PropertyGetInternalName(property,name,65)

	for(new i;i < TAX_TOWNS;i++)
	{
		if(equali(name,g_TownPrefix[i],strlen(g_TownPrefix[i])))
		{
			copy(key,len,g_TownKey[i])

			return true
		}
	}

	if(equali(name,"h9_jail"))
	{
		copy(key,len,"al")

		return true
	}

	return false
}

// whether the table of the treasuries is there (made once, with a query that waits, as the others are). A failure says why and is for the caller to report: unlike the others it does not
// leave the database alone for a minute, because the notice of the property that was taken back is still to be written.
stock bool:tax_db_table3(why[],len)
{
	if(g_DbMade3)
		return true

	new err,Handle:db = SQL_Connect(ARP_SqlHandle(),err,why,len)

	if(db == Empty_Handle || err)
		return false

	new query[300],bool:ok

	if(ARP_SqlMode() == MYSQL)
		formatex(query,299,TAX_SQL_TREAS_MYSQL,g_TreasTable)
	else
		formatex(query,299,TAX_SQL_TREAS_SQLITE,g_TreasTable)

	ok = tax_exec(db,query,why,len) >= 0

	SQL_FreeHandle(db)

	if(ok)
		g_DbMade3 = 1

	return ok
}

// adds a sum to the treasury of a town of this map, with statements that wait: 1 when it was added, 0 when the treasury cannot hold it (it never holds more than TAX_MAX_TREASURY), -1 when
// the database could not be written (why says what). The row of the town is made when there is none, with msr as its faction.
stock tax_treasury_add(const town[],amount,why[],len)
{
	if(!tax_db_ready())
	{
		copy(why,len,"the database cannot be used now")

		return -1
	}

	if(!tax_db_table3(why,len))
		return -1

	new err,Handle:db = SQL_Connect(ARP_SqlHandle(),err,why,len)

	if(db == Empty_Handle || err)
		return -1

	new query[400],tbl[140],tw[24],rows

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	copy(tw,23,town)
	ARP_SqlEscape(tw,23)

	if(ARP_SqlMode() == MYSQL)
		formatex(query,399,TAX_SQL_TREAS_ROW_MYSQL,g_TreasTable,tbl,tw)
	else
		formatex(query,399,TAX_SQL_TREAS_ROW_SQLITE,g_TreasTable,tbl,tw)

	rows = tax_exec(db,query,why,len)

	if(rows >= 0)
	{
		formatex(query,399,TAX_SQL_TREAS_ADD,g_TreasTable,amount,tbl,tw,TAX_MAX_TREASURY - amount)

		rows = tax_exec(db,query,why,len)
	}

	SQL_FreeHandle(db)
	g_DbWrites++

	return rows < 0 ? -1 : (rows > 0 ? 1 : 0)
}

// the profit of a property that is taken back goes to the treasury of its town (the header says why in this order): the database is written first, and the profit is set to 0 only when the
// statement says that the sum was added. Returns the sum that went there; 0 when nothing did (no treasury, no profit, or the profit stays with the property, which the log says).
stock tax_treasury_take(property,const name[])
{
	new profit,town[TAX_TOWN_LEN + 1],why[128],rows

	if(!tax_treasury())
		return 0

	profit = ARP_PropertyGetProfit(property)

	if(profit < 1)
		return 0

	if(!tax_town(property,town,TAX_TOWN_LEN))
	{
		log_amx("[ARP] property tax: the profit of %s ($%d) stays with it: the property is in no town of this map",name,profit)

		return 0
	}

	rows = tax_treasury_add(town,profit,why,127)

	if(rows < 0)
	{
		log_amx("[ARP] property tax: the profit of %s ($%d) stays with it: the treasury of the town %s could not be written (%s)",name,profit,town,why)

		return 0
	}

	if(rows < 1)
	{
		log_amx("[ARP] property tax: the profit of %s ($%d) stays with it: the treasury of the town %s cannot hold it",name,profit,town)

		return 0
	}

	ARP_PropertySetProfit(property,0)

	g_TreasSum = tax_add(g_TreasSum,profit)
	g_TreasNum++

	log_amx("[ARP] property tax: the profit of %s ($%d) went to the treasury of the town %s",name,profit,town)

	return profit
}

// the server takes a property back: it is for sale again at what its owner paid, locked or unlocked as it was before he bought it, with nobody's name or key on it and no keyholder, and
// its row is deleted. Its owner is told by tax_notice_flush. A property whose price was never learned (one an admin gave) keeps the price it has; one whose lock was not noted is sealed. Its profit goes to the
// treasury of its town when arp_h9_tax_treasury is 1 (tax_treasury_take), and stays with it when that is not possible.
stock tax_evict(r,property)
{
	new name[66],owner[36],lt = tax_limit_tolls(),tolls = g_RowTolls[r],due = g_RowDue[r],why,i,lock

	copy(name,65,g_RowName[r])
	copy(owner,35,g_RowOwner[r])
	why = lt > 0 && tolls >= lt ? 1 : 2
	lock = g_RowLock[r] >= 0 ? g_RowLock[r] : 1
	i = tax_base_find(name)

	tax_notice_add(TAX_N_GONE,property,owner,tolls,due,why,0)

	ARP_PropertySetOwnerName(property,"")
	ARP_PropertySetOwnerAuth(property,"")
	ARP_PropertyClearAccess(property)

	if(i >= 0 && g_BasePrice[i] > 0)
		ARP_PropertySetPrice(property,g_BasePrice[i])

	ARP_PropertySetLocked(property,lock)

	g_RowDue[r] = 0
	g_RowTolls[r] = 0
	g_RowAuto[r] = 0
	g_RowLock[r] = -1
	g_RowOwner[r][0] = 0
	tax_row_touch(r)

	g_LastGone++
	g_Gone++

	log_amx("[ARP] property tax: %s was taken back from %s (it owed $%d for %d tolls; %s; it is %slocked and its price is $%d)",name,owner,due,tolls,why == 1 ? "the period was used up" : "the ceiling was reached",lock ? "" : "un",ARP_PropertyGetPrice(property))

	tax_treasury_take(property,name)
}

// a property's row after a toll added to it: its owner is warned when it has passed half or three quarters of its allowance, and the server takes it back when the allowance is used up,
// but not in the first toll after the map began, and not while the database cannot be used (its owner's notice is written to it: the property goes at a later toll). Returns 1 when it was taken back.
// A row whose owner is no longer the property's owner (it was sold while a payment was on its way) is left alone.
stock tax_judge(r,property,before,tollNo)
{
	new after = tax_level(g_RowTolls[r],g_RowDue[r])

	if(after < 1 || !tax_row_owned(r,property))
		return 0

	if(after >= 3 && tollNo >= 2 && tax_db_ready2())
	{
		tax_evict(r,property)

		return 1
	}

	if(after > before)
		tax_notice_add(TAX_N_WARN,property,g_RowOwner[r],g_RowTolls[r],g_RowDue[r],0,tax_left_tolls(g_RowTolls[r],g_RowDue[r],tax_amount(property)))

	return 0
}

// ---------------------------------------------------------------------------------------------------------------------- payment by hand: the toll

// a toll when the tax is paid by hand. Each owned property that costs something at it owes more (a property that pays automatically is charged instead: see tax_auto_online and
// tax_auto_away), and the ones that have used up their allowance are taken back, which is the server's own act whoever is in the game.
stock tax_toll_hand()
{
	new owner[36],amount,o,r,p,left,late,before,id,add,players[MAX_PLAYERS],num,Float:now = get_gametime()

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
	g_LastHand = 0
	g_LastHandSum = 0
	g_LastShort = 0
	g_LastGone = 0
	g_LastWarned = 0
	g_OwnNum = 0
	g_NtNum = 0

	for(r = 0;r < g_RowNum;r++)
		g_RowSlot[r] = 0

	// what each owned property costs now, and who pays it automatically
	for(p = 1;ARP_ValidProperty(p);p++)
	{
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)

		if(!owner[0])
			continue

		amount = tax_amount(p)
		if(amount < 1)
			continue

		r = tax_row_for(p,owner)
		if(r < 0)
		{
			left++

			continue
		}

		// an automatic payment of an earlier toll that the database has not answered yet: the property is left alone until it is. The statement is still queued and will run, so another one for the same
		// money would charge it twice; the answer always comes (ARP_CleverQuery calls its handler for every statement it sends). The log says how many have waited more than TAX_PEND_SECS.
		if(g_RowPend[r])
		{
			if(now >= g_RowPendAt[r] + TAX_PEND_SECS)
				late++

			continue
		}

		g_LastProps++
		before = tax_level(g_RowTolls[r],g_RowDue[r])

		if(g_RowAuto[r])
		{
			o = tax_owner(owner)

			if(o >= 0)
			{
				add = g_RowDue[r] + amount
				g_OwnTotal[o] = tax_add(g_OwnTotal[o],add)

				if(g_OwnProps[o] < TAX_NAMES)
					g_OwnShown[o][g_OwnProps[o]] = p

				g_OwnProps[o]++
				g_RowAmt[r] = amount
				g_RowBefore[r] = before
				g_RowSlot[r] = o + 1

				continue
			}
		}

		tax_row_accrue(r,amount)
		g_LastHand++
		g_LastHandSum = tax_add(g_LastHandSum,amount)
		tax_judge(r,p,before,g_Tolls)
	}

	if(late)
		log_amx("[ARP] property tax: properties whose automatic payment has waited more than %d seconds for the database: %d (they are left out of this toll until it answers)",floatround(TAX_PEND_SECS),late)

	// the owners of automatic properties: in the game, away, or in the game with a character that has not loaded
	tax_scan(players,num)

	new bool:dbOk = g_OwnNum > 0 && tax_db_ready2()

	for(o = 0;o < g_OwnNum;o++)
	{
		id = tax_online(g_OwnKey[o],players,num)

		g_LastOwners++

		if(tax_cut(g_OwnKey[o]))
			g_LastCut++

		if(id && ARP_PlayerReady(id))
			tax_auto_online(id,o)
		else if(!id && dbOk)
			tax_auto_away(o)
		else
		{
			// his bank in memory is the truth while he is here and until his character has loaded it is not his, and a database that cannot be used pays nothing: it is owed. An owner who is in the game
			// is not judged at this toll (he may well have the money, and the next toll judges him)
			g_LastSkipped++
			tax_auto_short(o,id ? 0 : 1)
		}
	}

	tax_notice_flush()
	tax_rows_flush()

	log_amx("[ARP] property tax: toll %d (by hand): %d properties charged, %d owe $%d more, %d automatic owners (%d in the game: $%d taken, $%d short; %d away: $%d asked of the database), %d not paid, %d left out, %d taken back, %d warned%s",g_Tolls,g_LastProps,g_LastHand,g_LastHandSum,g_LastOwners,g_LastOnline,g_LastTaken,g_LastUnpaid,g_LastOffline,g_LastAway,g_LastShort,g_LastSkipped,g_LastGone,g_LastWarned,left ? " (and the properties beyond the table's room)" : "")
}

// the automatic properties of an owner of this toll could not be charged: what each costs at this toll is owed, as for a property paid by hand, and each is judged unless judge is 0
stock tax_auto_short(o,judge = 1)
{
	for(new r;r < g_RowNum;r++)
	{
		if(g_RowSlot[r] != o + 1)
			continue

		g_RowSlot[r] = 0
		tax_row_accrue(r,g_RowAmt[r])
		g_LastShort++

		if(judge)
			tax_judge(r,tax_row_property(r),g_RowBefore[r],g_Tolls)
	}
}

// an owner in the game whose character has loaded: what his automatic properties owe, with this toll's amount, comes out of his bank in memory when it holds it all, and he is told
stock tax_auto_online(id,o)
{
	new total = g_OwnTotal[o],bank = ARP_GetUserBank(id)
	static line[192]

	g_LastOnline++

	if(bank >= total)
	{
		ARP_SetUserBank(id,bank - total)
		g_LastTaken = tax_add(g_LastTaken,total)

		for(new r;r < g_RowNum;r++)
		{
			if(g_RowSlot[r] != o + 1)
				continue

			g_RowSlot[r] = 0
			tax_row_paid(r)
		}

		tax_line_online(o,total,0,line,191)
		client_print(id,print_chat,"%s",line)

		return
	}

	g_LastUnpaid = tax_add(g_LastUnpaid,total)
	tax_auto_short(o)

	tax_line_short(o,total,line,191)
	client_print(id,print_chat,"%s",line)
}

// an owner who is away: ONE statement takes the sum from his bank, and only when the bank holds it all; its answer says whether it did (the rows it affected), and the properties are settled
// then (TaxDbAuto). Their rows wait for it.
stock tax_auto_away(o)
{
	static query[500],condB[160]
	new total = g_OwnTotal[o],data[5],token = ++g_PendSeq,Float:now = get_gametime()

	tax_key_cond("authid",g_OwnKey[o],condB,159)
	formatex(query,499,TAX_SQL_AUTO,g_UsersTable,total,condB,total)

	for(new r;r < g_RowNum;r++)
	{
		if(g_RowSlot[r] != o + 1)
			continue

		g_RowSlot[r] = 0
		g_RowPend[r] = token
		g_RowPendAt[r] = now
	}

	data[0] = TAX_Q_AUTO
	data[1] = token
	data[2] = total
	data[3] = g_Tolls
	data[4] = g_OwnProps[o]

	g_DbWrites++
	g_LastOffline++
	g_LastAway = tax_add(g_LastAway,total)

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbAuto",query,data,5)
}

// the answer of the database to an automatic payment of an owner who was away: when the statement affected a row his bank held the sum and it was taken, and the properties are paid up;
// when it did not (the bank held less, or he has no row) they owe what the toll cost them, as for a property paid by hand. What was taken is added to his row of arp_h9_tax, for the popup he is
// shown when he is back. A property that was sold, or given to another, since the toll is its new owner's and is left alone (tax_row_owned).
// A payment whose property was sold, and whose row a later toll or the new owner's menu has made start again, before its answer comes finds no row that carries its number: its owner is debited all the
// same, and the row of arp_h9_tax that would show him what was taken is not written.
public TaxDbAuto(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused size,queuetime

	new token = data[1],total = data[2],tollNo = data[3],props = data[4],bool:paid,bool:any,property,key[36]

	if(failstate == TQUERY_SUCCESS && !errnum)
		paid = SQL_AffectedRows(query) > 0
	else
		tax_db_fail("automatic payment",error)

	tax_rates()

	for(new r;r < g_RowNum;r++)
	{
		if(!g_RowName[r][0] || g_RowPend[r] != token)
			continue

		g_RowPend[r] = 0

		// the owner whose bank was asked, as the rows of the toll named him
		if(!any)
		{
			any = true
			copy(key,35,g_RowOwner[r])
		}

		property = tax_row_property(r)

		// a property that was sold, or given to another, since the toll is its new owner's: what the old owner owed ends with the change, and nothing is accrued or taken back from the new one
		if(!tax_row_owned(r,property))
		{
			tax_row_orphan(r,property)

			continue
		}

		if(paid)
			tax_row_paid(r)
		else
		{
			tax_row_accrue(r,g_RowAmt[r])
			g_LastShort++
			tax_judge(r,property,g_RowBefore[r],tollNo)
		}
	}

	if(paid && any)
		tax_away_record(key,total,props)

	if(paid)
		g_LastTaken = tax_add(g_LastTaken,total)
	else
		g_LastUnpaid = tax_add(g_LastUnpaid,total)

	tax_notice_flush()
	tax_rows_flush()

	return PLUGIN_CONTINUE
}

// what an automatic payment took from an owner who was away goes in his row of arp_h9_tax (the row of the popup he is shown when he is back): the statement of a toll of the old kind
stock tax_away_record(const owner[],taken,props)
{
	if(!tax_db_ready())
		return

	static query[1000],take[32],condU[160],verb[24]
	new data[2]

	tax_key_cond("u.authid",owner,condU,159)
	formatex(take,31,"%d",taken)

	if(ARP_SqlMode() == MYSQL)
		copy(verb,23,"REPLACE INTO")
	else
		copy(verb,23,"INSERT OR REPLACE INTO")

	formatex(query,999,TAX_SQL_RECORD,verb,g_TaxTable,take,taken,take,props,get_systime(),g_UsersTable,g_TaxTable,condU)
	data[0] = TAX_Q_RECORD
	data[1] = taken
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbDone",query,data,2)
}

// "[ARP] Property tax for Flat A1: $120 could not be taken (not enough in your bank): it is owed now. Say /renew at its door to pay." The names give way to their number when the line is too long
stock tax_line_short(o,total,line[],len)
{
	new names[100]

	tax_names(o,names,99)
	tax_line_short_text(total,names,line,len)

	if(strlen(line) > TAX_LINE_MAX)
	{
		formatex(names,99,"%d propert%s",g_OwnProps[o],g_OwnProps[o] == 1 ? "y" : "ies")
		tax_line_short_text(total,names,line,len)
	}
}

stock tax_line_short_text(total,const names[],line[],len)
	formatex(line,len,"[ARP] Property tax for %s: $%d could not be taken (not enough in your bank), so it is owed now. Say /renew at the door to pay.",names,total)

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

	if(tax_by_hand())
		tax_init_dues()

	new Float:now = get_gametime(),Float:minutes = tax_minutes()

	if(g_LastToll == 0.0)
		g_LastToll = now

	if(g_NextToll == 0.0 || minutes != g_Minutes)
	{
		g_Minutes = minutes
		g_NextToll = g_LastToll + minutes * 60.0
	}

	// a toll waits for the prices of the properties (and, when the tax is paid by hand, for what they owe); a clock that is past due (a shorter interval) tolls at once, once
	if(now >= g_NextToll && g_BaseLoaded && (!tax_by_hand() || g_DueLoaded))
	{
		tax_toll()

		g_LastToll = now
		g_NextToll = now + minutes * 60.0
	}

	tax_away_pass(now)

	if(tax_by_hand())
		tax_rows_flush()
}

// ---------------------------------------------------------------------------------------------------------------------- the toll

// the slot of an owner in this toll (made when it is the first property of his), or -1 when the toll holds no more. The properties of one character can name him in more than one way (a property
// row saved while the core cut keys holds 32 or 33 characters of his key, a newer one all 35): they are one owner, and the longest text of his key is the one kept.
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
	if(tax_by_hand())
	{
		tax_toll_hand()

		return
	}

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
// it reads the bank as it is); the second takes it from his bank, never below 0, and only when the row with this time is there. A cut key (tax_cut) is a test of the beginning
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

	// payment by hand: his notices of properties taken back are asked for, and what his properties owe is told with the rest
	if(tax_by_hand())
	{
		g_Dues[id] = 1
		tax_note_ask(id)
	}

	return PLUGIN_CONTINUE
}

// the notices of properties the server took back from him are asked for (arp_h9_taxnote): shown with the row above, and deleted with the showing
stock tax_note_ask(id)
{
	if(!tax_db_ready2())
		return

	new key[72],query[300],data[3]

	copy(key,71,g_AwayKey[id])
	ARP_SqlEscape(key,71)
	formatex(query,299,TAX_SQL_NOTE_READ,g_NoteTable,key,TAX_NOTE_ROWS)

	data[0] = id
	data[1] = get_user_userid(id)
	data[2] = g_Seq[id]

	g_Note[id] = 1
	g_DbReads++

	ARP_CleverQuery(ARP_SqlHandle(),"TaxDbNote",query,data,3)
}

// the answer to the read of his notices: kept for the player, unless he is gone (or another joins in his slot) meanwhile
public TaxDbNote(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused size,queuetime

	new id = data[0]

	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || get_user_userid(id) != data[1] || g_Seq[id] != data[2] || g_Note[id] != 1)
		return PLUGIN_CONTINUE

	g_Note[id] = 0

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		tax_db_fail("notices",error)

		return PLUGIN_CONTINUE
	}

	new n,stamp

	while(SQL_MoreResults(query))
	{
		if(n < TAX_NAMES)
			SQL_ReadResult(query,0,g_NoteName[id][n],TAX_NAME_SHOWN + 3)

		stamp = max(stamp,SQL_ReadResult(query,4))
		n++

		SQL_NextRow(query)
	}

	if(n < 1)
		return PLUGIN_CONTINUE

	g_NoteNum[id] = n
	g_NoteStamp[id] = stamp
	g_AwayAt[id] = 0.0
	g_Note[id] = 2

	return PLUGIN_CONTINUE
}

// whether something is to be shown to a player who has joined (his row of what was taken while he was away, his notices of properties taken back, what his properties owe) and everything
// he was to be told has been read
stock bool:tax_login_ready(id)
{
	if(g_Away[id] == 1 || g_Note[id] == 1)
		return false

	return g_Away[id] == 2 || g_Note[id] == 2 || g_Dues[id] != 0
}

// the properties of a player's notices as a list of names: "A", "A and B", "A, B and C", and "A, B, C and 4 more"
stock tax_names_note(id,out[],len)
{
	new n = g_NoteNum[id],shown = min(n,TAX_NAMES)

	tax_join(g_NoteName[id],shown,n,out,len)
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

// once a second: a player who has something to be shown (his row of what was taken while he was away, his notices of properties taken back, what his properties owe) is shown it when he has
// been alive for TAX_AWAY_DELAY seconds (not while he picks a class or watches, and not before the game has drawn its HUD), and the delay starts again if he dies first
stock tax_away_pass(Float:now)
{
	new players[MAX_PLAYERS],num,id

	get_players(players,num,"ch")

	for(new i;i < num;i++)
	{
		id = players[i]

		if(!tax_login_ready(id))
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
		g_Note[id] = 0
		g_Dues[id] = 0

		return
	}

	g_AwayAt[id] = get_gametime() + TAX_AWAY_RETRY
}

// what a player who has joined is shown, all at once: his row of what was taken while he was away and his notices of properties taken back are deleted (the rows he is shown: a row made since
// has another time and stays for his next visit) with statements that wait, and he is told only when the statement removed them: a row that is not gone is never shown, and one somebody else
// removed is not shown twice. A statement that fails leaves him waiting for the next try, and what is done is not done again.
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

	new key[72],query[300],rows,names[100]
	static line[192]

	copy(key,71,g_AwayKey[id])
	ARP_SqlEscape(key,71)

	if(g_Away[id] == 2)
	{
		formatex(query,299,TAX_SQL_CLEAR,g_TaxTable,key,g_AwayStamp[id])

		rows = tax_exec(db,query,msg,127)

		g_DbWrites++

		if(rows < 0)
		{
			SQL_FreeHandle(db)
			tax_away_fail(id,"the delete",msg)

			return
		}

		g_Away[id] = 0

		if(rows >= 1 && g_AwayTaken[id] + g_AwayUnpaid[id] >= 1)
		{
			tax_line_away(g_AwayTaken[id],g_AwayUnpaid[id],g_AwayTolls[id],g_AwayProps[id],line,191)
			client_print(id,print_chat,"%s",line)
		}
	}

	if(g_Note[id] == 2)
	{
		formatex(query,299,TAX_SQL_NOTE_CLEAR,g_NoteTable,key,g_NoteStamp[id])

		rows = tax_exec(db,query,msg,127)

		g_DbWrites++

		if(rows < 0)
		{
			SQL_FreeHandle(db)
			tax_away_fail(id,"the delete of notices",msg)

			return
		}

		g_Note[id] = 0

		if(rows >= 1)
		{
			tax_names_note(id,names,99)
			tax_line_gone_text(names,g_NoteNum[id],true,line,191)

			if(strlen(line) > TAX_LINE_MAX)
			{
				formatex(names,99,"%d propert%s",g_NoteNum[id],g_NoteNum[id] == 1 ? "y" : "ies")
				tax_line_gone_text(names,g_NoteNum[id],true,line,191)
			}

			client_print(id,print_chat,"%s",line)
		}
	}

	SQL_FreeHandle(db)

	if(g_Dues[id])
	{
		g_Dues[id] = 0

		if(tax_by_hand() && tax_due_line(g_AwayKey[id],line,191))
			client_print(id,print_chat,"%s",line)
	}
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

	// by hand: what each property owes and how long it has, as well
	if(tax_by_hand())
	{
		tax_report(id)

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

// ---------------------------------------------------------------------------------------------------------------------- say /renew and the menu of a property

// the property whose door the player looks at, within 200 units (the test /sell and /lock make; any door of a property gives it): 0 when it is not a door of a property
stock tax_aimed(id)
{
	new Index,Body,Targetname[33]

	get_user_aiming(id,Index,Body,200)

	if(!Index)
		return 0

	entity_get_string(Index,EV_SZ_targetname,Targetname,32)

	if(!ARP_ValidDoorName(Targetname,Index))
		return 0

	return ARP_PropertyMatch(Targetname,Index)
}

// the properties of an owner that owe something, the nearest to being taken back first: their numbers, the tolls each has left (-1: no limit) and what each owes (the first TAX_LIST_MAX
// of them). Returns how many there are in all; `total` is what they owe together.
stock tax_dues(const key[],props[],lefts[],dues[],&total)
{
	new owner[36],n,count,r,left,i,j

	total = 0
	tax_rates()

	for(new p = 1;key[0] && ARP_ValidProperty(p);p++)
	{
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)

		if(!tax_owns(owner,key))
			continue

		r = tax_row_peek(p,owner)
		if(r < 0 || g_RowDue[r] < 1)
			continue

		count++
		total = tax_add(total,g_RowDue[r])
		left = tax_left_tolls(g_RowTolls[r],g_RowDue[r],tax_amount(p))

		// its place: before the first that has more tolls left (a property with no limit has the most)
		for(i = 0;i < n;i++)
			if(left >= 0 && (lefts[i] < 0 || left < lefts[i]))
				break

		if(i >= TAX_LIST_MAX)
			continue

		if(n < TAX_LIST_MAX)
			n++

		for(j = n - 1;j > i;j--)
		{
			props[j] = props[j - 1]
			lefts[j] = lefts[j - 1]
			dues[j] = dues[j - 1]
		}

		props[i] = p
		lefts[i] = left
		dues[i] = g_RowDue[r]
	}

	return count
}

// one line of what an owner's properties owe, for his login popup and /tax: the ones nearest to being taken back first, each with what it owes and how long it has left. 0 when nothing is
// owed. "[ARP] Property tax owed: Flat A1 $120 (about 18 hours left), Shop A3 $30 (about 22 hours left) and 1 more. You must pay it: say /renew at the door."
stock tax_due_line(const key[],line[],len)
{
	new props[TAX_LIST_MAX],lefts[TAX_LIST_MAX],dues[TAX_LIST_MAX],count,total,shown,used,until[40],name[TAX_NAME_SHOWN + 4]

	count = tax_dues(key,props,lefts,dues,total)

	if(count < 1)
		return 0

	// as many names as fit in a popup: three, then two, then one
	for(shown = min(min(count,TAX_LIST_MAX),TAX_NAMES);shown >= 1;shown--)
	{
		used = formatex(line,len,"[ARP] Property tax owed: ")

		for(new i;i < shown;i++)
		{
			tax_prop_name(props[i],name,TAX_NAME_SHOWN + 3)

			if(i > 0)
				used += formatex(line[used],len - used,", ")

			if(lefts[i] > 0)
			{
				tax_time_text(tax_secs_left(lefts[i]),until,39)
				used += formatex(line[used],len - used,"%s $%d (%s left)",name,dues[i],until)
			}
			else
				used += formatex(line[used],len - used,"%s $%d",name,dues[i])
		}

		if(count > shown)
			used += formatex(line[used],len - used," and %d more",count - shown)

		formatex(line[used],len - used,". You must pay it: say /renew at the door.")

		if(strlen(line) <= TAX_LINE_MAX)
			return 1
	}

	// no name fits
	formatex(line,len,"[ARP] Property tax owed: $%d on %d propert%s. You must pay it: say /renew at the door of each.",total,count,count == 1 ? "y" : "ies")

	return 1
}

// what the player's properties cost and owe, for /tax and /renew: a line in chat (a popup), a line of what is owed and how long each has left, and the list in the console
stock tax_report(id)
{
	new key[36],owner[36],count,total,listed,r,due,dueAll,tolls,left,auto,p,amount,listProp[TAX_LIST_MAX]
	new name[TAX_NAME_SHOWN + 4],span[32],next[32],until[40],owes[48],more[64],Float:wait
	static line[192]

	if(!g_DueLoaded)
	{
		client_print(id,print_chat,"[ARP] Property tax is not ready yet: try again in a moment.")

		return
	}

	tax_rates()
	tax_key(id,key,35)

	for(p = 1;key[0] && ARP_ValidProperty(p);p++)
	{
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)

		if(!tax_owns(owner,key))
			continue

		count++
		total = min(total + tax_amount(p),2000000000)
		r = tax_row_peek(p,owner)

		if(r >= 0)
			dueAll = tax_add(dueAll,g_RowDue[r])

		if(listed < TAX_LIST_MAX)
			listProp[listed++] = p
	}

	if(!count)
	{
		client_print(id,print_chat,"[ARP] You own no property, so you pay no property tax.")

		return
	}

	wait = g_NextToll > 0.0 ? g_NextToll - get_gametime() : tax_minutes() * 60.0
	tax_span(tax_minutes(),span,31)
	tax_in(wait,next,31)

	if(total < 1 && dueAll < 1)
		client_print(id,print_chat,"[ARP] Property tax: none of your %d propert%s is charged at the moment.",count,count == 1 ? "y" : "ies")
	else
		client_print(id,print_chat,"[ARP] Property tax: $%d at each toll, every %s, for %d propert%s; the next toll is %s.",total,span,count,count == 1 ? "y" : "ies",next)

	if(dueAll > 0 && tax_due_line(key,line,191))
		client_print(id,print_chat,"%s",line)

	client_print(id,print_console,"Property tax, every %s (the next toll is %s):",span,next)

	for(new i;i < listed;i++)
	{
		p = listProp[i]
		owner[0] = 0
		ARP_PropertyGetOwnerAuth(p,owner,35)
		r = tax_row_peek(p,owner)
		due = r >= 0 ? g_RowDue[r] : 0
		tolls = r >= 0 ? g_RowTolls[r] : 0
		auto = r >= 0 ? g_RowAuto[r] : 0
		amount = tax_amount(p)
		more[0] = 0

		if(due > 0)
		{
			formatex(owes,47,"owes $%d (%d toll%s)",due,tolls,tolls == 1 ? "" : "s")
			left = tax_left_tolls(tolls,due,amount)

			if(left > 0)
			{
				tax_time_text(tax_secs_left(left),until,39)
				formatex(more,63,", %s left",until)
			}
		}
		else
			copy(owes,47,"owes nothing")

		tax_prop_name(p,name,TAX_NAME_SHOWN + 3)
		client_print(id,print_console,"  %s: $%d a toll, %s, %s%s",name,amount,owes,auto ? "pays automatically" : "pays by hand",more)
	}

	if(count > listed)
		client_print(id,print_console,"  and %d more",count - listed)

	client_print(id,print_console,"  Total: $%d at each toll, $%d owed",total,dueAll)
}

// /renew and /paytax: the menu of the property whose door the player looks at, when it is his; for any other door, or none, what he owes in all. With arp_h9_tax_manual 0 they are not
// commands: the line is chat.
public SayRenew(id,Mode,Args[])
{
	#pragma unused Mode,Args

	if(!tax_by_hand())
		return PLUGIN_CONTINUE

	if(!ARP_PlayerReady(id))
	{
		client_print(id,print_chat,"[ARP] Your character has not loaded yet.")

		return PLUGIN_HANDLED
	}

	tax_renew(id,is_user_alive(id) ? tax_aimed(id) : 0)

	return PLUGIN_HANDLED
}

public SayPayTax(id,Mode,Args[])
	return SayRenew(id,Mode,Args)

// the menu of a property that is the player's; for any other property, or none, what he owes in all
stock tax_renew(id,property)
{
	new key[36],owner[36],name[TAX_NAME_SHOWN + 4]

	if(!g_DueLoaded)
	{
		client_print(id,print_chat,"[ARP] Property tax is not ready yet: try again in a moment.")

		return
	}

	tax_key(id,key,35)

	if(property)
		ARP_PropertyGetOwnerAuth(property,owner,35)

	if(property && tax_owns(owner,key))
	{
		tax_rates()

		if(tax_amount(property) < 1)
		{
			tax_prop_name(property,name,TAX_NAME_SHOWN + 3)
			client_print(id,print_chat,"[ARP] %s costs no property tax.",name)

			return
		}

		ARP_PropertyGetInternalName(property,g_MenuProp[id],65)
		tax_menu_show(id,property)

		return
	}

	if(property)
		client_print(id,print_chat,"[ARP] That property is not yours.")
	else
		client_print(id,print_chat,"[ARP] You are not looking at a door of a property of yours: face one of its doors and say /renew.")

	tax_report(id)
}

// the menu of a property: what it costs and owes, how long it has, the owner's bank and wallet, 1. pay, 2. automatic payment on or off, 0. close. An H9 panel on a game that draws them (the
// rows are read out of this text), the classic menu on any other.
stock tax_menu_show(id,property)
{
	static text[700]
	new name[TAX_NAME_SHOWN + 4],owner[36],r,amount,due,tolls,left,bool:auto,pos,until[40],bank = ARP_GetUserBank(id),wallet = ARP_GetUserWallet(id)

	tax_rates()
	tax_prop_name(property,name,TAX_NAME_SHOWN + 3)
	ARP_PropertyGetOwnerAuth(property,owner,35)
	r = tax_row_peek(property,owner)
	amount = tax_amount(property)

	if(r >= 0)
	{
		due = g_RowDue[r]
		tolls = g_RowTolls[r]
		auto = g_RowAuto[r] != 0
	}

	pos = formatex(text,699,"ARP Property Tax^n^n%s^nTax a toll: $%d^n",name,amount)

	if(due > 0)
		pos += formatex(text[pos],699 - pos,"Owes: $%d (%d toll%s)^n",due,tolls,tolls == 1 ? "" : "s")
	else
		pos += formatex(text[pos],699 - pos,"Owes: nothing^n")

	left = due > 0 ? tax_left_tolls(tolls,due,amount) : -1

	if(left > 0)
	{
		tax_time_text(tax_secs_left(left),until,39)
		pos += formatex(text[pos],699 - pos,"Left: %d toll%s^nTime: %s^n",left,left == 1 ? "" : "s",until)
	}

	pos += formatex(text[pos],699 - pos,"Bank: $%d^nWallet: $%d^n^n",bank,wallet)

	if(due > 0)
		pos += formatex(text[pos],699 - pos,"1. Pay $%d now^n",due)
	else
		pos += formatex(text[pos],699 - pos,"\d1. Pay (nothing owed)^n\w")

	formatex(text[pos],699 - pos,"2. Automatic payment  %s^n^n0. Close",auto ? "ON" : "OFF")

	arpvgui_show_menu(id,MENU_KEY_1|MENU_KEY_2|MENU_KEY_0,text,-1,g_MenuName,TAX_MENU_PANEL)
}

// the property of a player's open menu, if it is still his and the tax is still paid by hand: 0 when not
stock tax_menu_property(id)
{
	new property,key[36],owner[36]

	if(!g_MenuProp[id][0] || !tax_by_hand() || !g_DueLoaded || !is_user_connected(id) || !ARP_PlayerReady(id))
		return 0

	property = ARP_PropertyMatch(_,_,g_MenuProp[id])

	if(!property)
		return 0

	tax_key(id,key,35)
	ARP_PropertyGetOwnerAuth(property,owner,35)

	return tax_owns(owner,key) ? property : 0
}

// a key of the menu: 1 pays, 2 turns the automatic payment on or off, 0 closes it. What the menu shows is checked again here: it may have been open for a while.
public TaxMenuHandle(id,key)
{
	new property

	if(id < 1 || id > MAX_PLAYERS || key == 9)
	{
		if(id >= 1 && id <= MAX_PLAYERS)
			g_MenuProp[id][0] = 0

		return PLUGIN_HANDLED
	}

	property = tax_menu_property(id)

	if(!property)
	{
		g_MenuProp[id][0] = 0
		client_print(id,print_chat,"[ARP] That property is no longer yours, or its tax is no longer paid by hand.")

		return PLUGIN_HANDLED
	}

	if(key == 0)
		tax_pay(id,property)
	else if(key == 1)
		tax_toggle(id,property)

	if(tax_menu_property(id))
		tax_menu_show(id,property)

	return PLUGIN_HANDLED
}

// pays what a property owes: from the bank, and the rest from the wallet when the bank holds less (a part payment is not made: when both together hold less, nothing is taken)
stock tax_pay(id,property)
{
	new owner[36],r,due,bank,wallet,fromBank,fromWallet,name[TAX_NAME_SHOWN + 4],internal[66],authid[36],player[33]

	ARP_PropertyGetOwnerAuth(property,owner,35)
	ARP_PropertyGetInternalName(property,internal,65)
	r = tax_row_peek(property,owner)
	tax_prop_name(property,name,TAX_NAME_SHOWN + 3)

	if(r < 0 || g_RowDue[r] < 1)
	{
		client_print(id,print_chat,"[ARP] %s owes no property tax.",name)

		return
	}

	if(g_RowPend[r])
	{
		client_print(id,print_chat,"[ARP] The tax of %s is being taken from your bank at this moment: try again in a few seconds.",name)

		return
	}

	due = g_RowDue[r]
	bank = max(ARP_GetUserBank(id),0)
	wallet = max(ARP_GetUserWallet(id),0)
	fromBank = min(bank,due)
	fromWallet = due - fromBank

	if(fromWallet > wallet)
	{
		client_print(id,print_chat,"[ARP] You cannot pay the $%d that %s owes: your bank holds $%d and your wallet $%d.",due,name,bank,wallet)

		return
	}

	if(fromBank > 0)
		ARP_SetUserBank(id,bank - fromBank)

	if(fromWallet > 0)
		ARP_SetUserWallet(id,wallet - fromWallet)

	tax_row_paid(r)
	tax_rows_flush()

	if(fromWallet < 1)
		client_print(id,print_chat,"[ARP] Property tax paid: $%d taken from your bank for %s.",fromBank,name)
	else if(fromBank < 1)
		client_print(id,print_chat,"[ARP] Property tax paid: $%d taken from your wallet for %s.",fromWallet,name)
	else
		client_print(id,print_chat,"[ARP] Property tax paid: $%d taken from your bank and $%d from your wallet for %s.",fromBank,fromWallet,name)

	get_user_name(id,player,32)
	get_user_authid(id,authid,35)
	ARP_Log("Cmd: ^"%s<%d><%s>^" paid $%d property tax of ^"%s^" ($%d from the bank, $%d from the wallet)",player,get_user_userid(id),authid,due,internal,fromBank,fromWallet)
}

// turns the automatic payment of a property on or off
stock tax_toggle(id,property)
{
	new owner[36],r,name[TAX_NAME_SHOWN + 4],internal[66],authid[36],player[33]

	ARP_PropertyGetOwnerAuth(property,owner,35)
	ARP_PropertyGetInternalName(property,internal,65)
	tax_prop_name(property,name,TAX_NAME_SHOWN + 3)
	r = tax_row_for(property,owner)

	if(r < 0)
	{
		client_print(id,print_chat,"[ARP] The property tax cannot keep the automatic payment of one more property.")

		return
	}

	if(g_RowPend[r])
	{
		client_print(id,print_chat,"[ARP] The tax of %s is being taken from your bank at this moment: try again in a few seconds.",name)

		return
	}

	g_RowAuto[r] = g_RowAuto[r] ? 0 : 1
	tax_row_touch(r)
	tax_rows_flush()

	if(g_RowAuto[r])
		client_print(id,print_chat,"[ARP] Automatic property tax payment for %s is ON: each toll takes what it owes and the toll's tax from your bank, when the bank holds it all.",name)
	else
		client_print(id,print_chat,"[ARP] Automatic property tax payment for %s is OFF: you pay it by hand (say /renew at its door).",name)

	get_user_name(id,player,32)
	get_user_authid(id,authid,35)
	ARP_Log("Cmd: ^"%s<%d><%s>^" turned the automatic property tax payment of ^"%s^" %s",player,get_user_userid(id),authid,internal,g_RowAuto[r] ? "on" : "off")
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

	if(get_pcvar_num(p_Manual) || g_DueInited)
	{
		new used,owing,paying,pend,dirty,sum

		for(new r;r < g_RowNum;r++)
		{
			if(!g_RowName[r][0])
				continue

			used++
			owing += g_RowDue[r] > 0 ? 1 : 0
			paying += g_RowAuto[r] ? 1 : 0
			pend += g_RowPend[r] ? 1 : 0
			dirty += g_RowDirty[r] ? 1 : 0
			sum = tax_add(sum,g_RowDue[r])
		}

		console_print(id,"HAND manual=%d evict=%d limit_tolls=%d limit_debt=%d loaded=%d rows=%d owing=%d owed=%d automatic=%d on_its_way=%d to_write=%d",get_pcvar_num(p_Manual),get_pcvar_num(p_Evict),tax_limit_tolls(),tax_limit_debt(),g_DueLoaded,used,owing,sum,paying,pend,dirty)
		console_print(id,"HANDLAST properties=%d owed_more=%d owed_more_sum=%d automatic_owners=%d in_game=%d taken=%d unpaid=%d away=%d asked=%d unpaid_properties=%d left_out=%d gone=%d warned=%d gone_total=%d",g_LastProps,g_LastHand,g_LastHandSum,g_LastOwners,g_LastOnline,g_LastTaken,g_LastUnpaid,g_LastOffline,g_LastAway,g_LastShort,g_LastSkipped,g_LastGone,g_LastWarned,g_Gone)
		console_print(id,"HANDDB made=%d due_table=%s note_table=%s",g_DbMade2,g_DueTable,g_NoteTable)
	}

	return PLUGIN_HANDLED
}

// arp_h9_tax_towns: the towns of this map, who runs each and what each treasury holds. A town that has no row yet is run by msr and holds nothing.
public CmdTowns(id,level,cid)
{
	#pragma unused level

	if(!ARP_CmdAccess(id,cid,1))
		return PLUGIN_HANDLED

	if(!get_pcvar_num(p_Tax))
	{
		console_print(id,"[ARP] arp_h9_tax is 0: the property tax does nothing.")

		return PLUGIN_HANDLED
	}

	new map[32],why[128],err,Handle:db,Handle:st,query[300],tbl[140],n,i,j,listN
	new rowKey[16][TAX_TOWN_LEN + 1],rowFaction[16][TAX_TOWN_LEN + 1],rowBalance[16],rowShown[16]
	new listKey[TAX_TOWNS][TAX_TOWN_LEN + 1],listName[TAX_TOWNS][20]

	get_mapname(map,31)

	console_print(id,"TREASURY on=%d manual=%d evict=%d map=%s hive=%d credited=%d properties=%d",get_pcvar_num(p_Treasury),get_pcvar_num(p_Manual),get_pcvar_num(p_Evict),map,tax_hive() ? 1 : 0,g_TreasSum,g_TreasNum)

	if(!get_pcvar_num(p_Treasury))
	{
		console_print(id,"[ARP] arp_h9_tax_treasury is 0: the profit of a property that is taken back stays with it, and no town has a treasury.")

		return PLUGIN_HANDLED
	}

	if(!tax_db_ready())
	{
		console_print(id,"[ARP] The database cannot be used now.")

		return PLUGIN_HANDLED
	}

	if(!tax_db_table3(why,127))
	{
		console_print(id,"[ARP] The table of the treasuries could not be made (%s).",why)

		return PLUGIN_HANDLED
	}

	db = SQL_Connect(ARP_SqlHandle(),err,why,127)

	if(db == Empty_Handle || err)
	{
		console_print(id,"[ARP] The database cannot be used now (%s).",why)

		return PLUGIN_HANDLED
	}

	copy(tbl,139,g_PropTable)
	ARP_SqlEscape(tbl,139)
	formatex(query,299,TAX_SQL_TREAS_READ,g_TreasTable,tbl)
	st = SQL_PrepareQuery(db,"%s",query)

	if(!SQL_Execute(st))
	{
		SQL_QueryError(st,why,127)
		SQL_FreeHandle(st)
		SQL_FreeHandle(db)
		console_print(id,"[ARP] The treasuries could not be read (%s).",why)

		return PLUGIN_HANDLED
	}

	while(SQL_MoreResults(st) && n < 16)
	{
		SQL_ReadResult(st,0,rowKey[n],TAX_TOWN_LEN)
		SQL_ReadResult(st,1,rowFaction[n],TAX_TOWN_LEN)
		rowBalance[n] = SQL_ReadResult(st,2)

		if(!rowFaction[n][0])
			copy(rowFaction[n],TAX_TOWN_LEN,"msr")

		n++

		SQL_NextRow(st)
	}

	SQL_FreeHandle(st)
	SQL_FreeHandle(db)
	g_DbReads++

	if(tax_hive())
	{
		for(i = 0;i < TAX_TOWNS;i++)
		{
			copy(listKey[i],TAX_TOWN_LEN,g_TownKey[i])
			copy(listName[i],19,g_TownName[i])
		}

		listN = TAX_TOWNS
	}
	else
	{
		copy(listKey[0],TAX_TOWN_LEN,"all")
		copy(listName[0],19,"the whole map")

		listN = 1
	}

	for(i = 0;i < listN;i++)
	{
		for(j = 0;j < n;j++)
			if(equali(rowKey[j],listKey[i]))
				break

		if(j < n)
		{
			rowShown[j] = 1

			console_print(id,"TOWN %s faction=%s balance=%d (%s)",listKey[i],rowFaction[j],rowBalance[j],listName[i])
		}
		else
			console_print(id,"TOWN %s faction=msr balance=0 (%s; no row yet)",listKey[i],listName[i])
	}

	for(j = 0;j < n;j++)
		if(!rowShown[j])
			console_print(id,"TOWN %s faction=%s balance=%d (not a town of this map)",rowKey[j],rowFaction[j],rowBalance[j])

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
