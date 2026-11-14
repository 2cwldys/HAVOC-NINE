#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <engine>
#include <ApolloRP>
#include <ApolloRP_VGui>

// H9: ARP_Inventory -- a player's items arranged in cells, and the window and the exchange of goods that draw them.
//
// Truth of the counts stays ARP's: ARP_GetUserItemNum and the arp_items table are what a player owns. This plugin keeps, for each player in
// the game, the ARRANGEMENT of those counts: a number of cells, each empty or holding one kind of item and a count of it up to a stack limit.
// It is made when his character has loaded (his items packed in item order, then laid out as he left it: the arrangement is kept in the table arp_h9_cells) and lives while
// he is in the game.
// The core (ARP_Core) tells this plugin before it changes a count (ARP_InvOnCount), asks it how much fits (ARP_InvOnRoom), brackets an item's use
// (ARP_InvOnUse) and hands it the lines to say (ARP_InvOnNote); include\ApolloRP_Items.inc says what each does. With this plugin not loaded, or
// paused, the core answers none of them and is stock Apollo RP.
//
// A player whose game draws H9's inventory window (_h9vgui 6, H9VGUI_INV_PROTOCOL in include\h9_vgui.inc) is sent the cells in the user message H9Inv and
// drives them with the client command h9inv; every other player keeps the text menu, and the cell rules (a limit of cells, a stack limit) apply to all of them.
// The exchange of goods between two players is the user message H9Trade and "h9inv x ...", the search of a handcuffed player (a game that says _h9vgui 8) the user message
// H9Search and "h9inv s ...". The rules, the switches and the protocol are written down in docs\ARP_INVENTORY.txt (docs\APOLLO_RP.txt, section 9, is the short form):
// arp_h9_vgui, arp_h9_inv_window, arp_h9_inv_slots, arp_h9_inv_stack, arp_h9_inv_persist, arp_h9_credits, arp_h9_trade_range, arp_h9_trade_timeout, arp_h9_search and
// arp_h9_search_range switch it.

#pragma dynamic 8192

#define INV_MAX_CELLS    256     // the cells one player can have: an inventory without a limit grows to here
#define INV_MIN_SLOTS    8
#define INV_MAX_SLOTS    96
#define INV_GRID_MIN     32      // the least grid of an inventory without a limit
#define INV_MAX_KINDS    255     // the kinds of item the arrangement and the catalog cover (ARP registers about ninety)
#define INV_MAX_STACK    999
#define INV_MSG_MAX      188     // bytes of one user message (include\h9_vgui.inc, H9VGUI_MSG_MAX)
#define INV_SLOTS_CHUNK  40      // cells in one SLOTS message
#define INV_NAME_LEN     33
#define INV_GIVE_RANGE   200.0   // units: how far a player may give an item from
#define INV_SHOW_RANGE   150.0   // and show one from

// the user message H9Inv, server to client: the first byte of each is its op
#define INV_OP_OPEN      1
#define INV_OP_CATALOG   2
#define INV_OP_SLOTS     3
#define INV_OP_MONEY     4
#define INV_OP_DESC      5
#define INV_OP_NOTE      6
#define INV_OP_CLOSE     7
#define INV_OP_RESERVE   8

#define INV_TASK_FLUSH   1000    // + the player: a flush that is due
#define INV_TICK         0.25    // seconds between the passes over the open windows

// the cvars
new p_Window
new p_Slots
new p_Stack
new p_Credits
new p_Persist
new p_Search
new p_SearchRange
new p_SearchMoney

new g_MsgInv
new g_MsgTrade
new g_MsgSearch

// the cells of each player: the kind in each (0: empty) and the count; g_Res is the count an open exchange holds of a cell (0: free)
new g_On[MAX_PLAYERS + 1]                       // 1: his character is loaded and the cells are his arrangement
new g_CK[MAX_PLAYERS + 1][INV_MAX_CELLS]
new g_CN[MAX_PLAYERS + 1][INV_MAX_CELLS]
new g_Res[MAX_PLAYERS + 1][INV_MAX_CELLS]
new g_Over[MAX_PLAYERS + 1]                     // 1: a cell holds more than the stack limit (a limit lowered, or more than the grid can hold)
new g_Lost[MAX_PLAYERS + 1]                     // items a packing could not place in any cell (only when more than INV_MAX_CELLS cells would be needed)
new g_Repairs[MAX_PLAYERS + 1]                  // times the cells were found to disagree with the count of a kind and were corrected

// a window that is open: what the client has been sent, so that only the difference is sent next
new g_Open[MAX_PLAYERS + 1]
new g_PendOpen[MAX_PLAYERS + 1]                 // the header (and with it everything) is to be sent
new g_SK[MAX_PLAYERS + 1][INV_MAX_CELLS]        // the kind of each cell as sent (-1: not sent)
new g_SN[MAX_PLAYERS + 1][INV_MAX_CELLS]
new g_SR[MAX_PLAYERS + 1][INV_MAX_CELLS]        // the reserve of each cell as sent
new g_CatSent[MAX_PLAYERS + 1][INV_MAX_KINDS + 1]
new g_SentShown[MAX_PLAYERS + 1]
new g_SentFlags[MAX_PLAYERS + 1]
new g_SentWallet[MAX_PLAYERS + 1]
new g_SentBank[MAX_PLAYERS + 1]
new Float:g_MoneyAt[MAX_PLAYERS + 1]
new g_FlushTask[MAX_PLAYERS + 1]
new Float:g_FrameAt[MAX_PLAYERS + 1]            // the game time of the last message to him, and how many went in that frame
new g_FrameMsgs[MAX_PLAYERS + 1]
new Float:g_CmdAt[MAX_PLAYERS + 1]              // his h9inv commands in this second
new g_CmdCount[MAX_PLAYERS + 1]

// what the player is doing with a cell, so that the count the core takes is taken from that cell first
new g_ActKind[MAX_PLAYERS + 1]
new g_ActCell[MAX_PLAYERS + 1]
new g_UseKind[MAX_PLAYERS + 1]                  // an item of his is being used (ARP_InvOnUse)
new g_UseCell[MAX_PLAYERS + 1]
new g_UseSlack[MAX_PLAYERS + 1]                 // a handler gave the unit back to a full cell: it is held above the stack limit until the use ends
new g_Self[MAX_PLAYERS + 1]                     // this plugin is changing his counts itself and has arranged the cells already

// the search of a handcuffed player (its part is below): the first _h9vgui whose game draws the window (include\h9_vgui.inc has it as H9VGUI_SEARCH_PROTOCOL once it is added there)
#if !defined H9VGUI_SEARCH_PROTOCOL
	#define H9VGUI_SEARCH_PROTOCOL 8
#endif
// the first _h9vgui whose game reads H9Search op 5 (MONEY) and offers to take money from the player searched
#if !defined H9VGUI_SEARCHMONEY_PROTOCOL
	#define H9VGUI_SEARCHMONEY_PROTOCOL 9
#endif

#define SR_OP_OPEN       1       // the user message H9Search, server to client: the first byte of each is its op
#define SR_OP_SLOTS      2
#define SR_OP_CLOSE      3
#define SR_OP_NOTE       4
#define SR_OP_MONEY      5       // long wallet: what the player searched holds in his wallet

// close reasons (H9Search CLOSE)
#define SR_CLOSED        0       // he closed it
#define SR_FREED         1       // the other is no longer handcuffed or jailed
#define SR_DIED          2       // the other died
#define SR_LEFT          3       // the other left the game
#define SR_FAR           4       // he went too far from the other
#define SR_GONE          5       // he died, was handcuffed or lost his window
#define SR_OFF           6       // the map is changing, or a switch was turned off

new g_SrTarget[MAX_PLAYERS + 1]                 // the player this player is searching (0: nobody)
new g_SrBy[MAX_PLAYERS + 1]                     // the player who is searching this player (0: nobody)
new g_SrPending[MAX_PLAYERS + 1]                // the header and the snapshot of the search window are due
new g_SrShown[MAX_PLAYERS + 1]                  // what the searcher's game was told of the other's grid: its length, its flags, and each cell
new g_SrFlags[MAX_PLAYERS + 1]
new g_SrMoney[MAX_PLAYERS + 1]                  // his wallet as the searcher's game was last told it (-1: not told)
new g_SrSK[MAX_PLAYERS + 1][INV_MAX_CELLS]
new g_SrSN[MAX_PLAYERS + 1][INV_MAX_CELLS]

// the exchange of goods (the code is below, in the exchange's own part)
#define TR_OP_INVITE     1
#define TR_OP_OPEN       2
#define TR_OP_OFFER      3
#define TR_OP_MONEY      4
#define TR_OP_SEAL       5
#define TR_OP_CLOSE      6

// the reasons of a CLOSE
#define TR_DONE          0
#define TR_YOU_WITHDREW  1
#define TR_THEY_WITHDREW 2
#define TR_DECLINED      3
#define TR_LAPSED        4
#define TR_RANGE         5
#define TR_YOU_DIED      6
#define TR_THEY_DIED     7
#define TR_THEY_LEFT     8
#define TR_RESTRAINED    9
#define TR_YOUR_FULL     10
#define TR_THEIR_FULL    11
#define TR_CHECK_FAILED  12
#define TR_MAP_CHANGE    13
#define TR_BUSY          14
#define TR_TIMED_OUT     15

#define TR_IDLE          0
#define TR_INVITING      1       // he pressed use on a player and waits for the answer
#define TR_INVITED       2       // a player pressed use on him
#define TR_TRADING       3

#define TR_CELLS         12      // entries of an offer
#define TR_INVITE_SECS   12
#define TR_SEAL_LOCK     3.0     // seconds the seal is dead after a change
#define TR_PAIR_WAIT     2.0     // seconds before the same two may start again
#define TR_INVITE_GAP    3.0     // seconds between one player's invitations

new p_TradeRange
new p_TradeTimeout

new g_TrState[MAX_PLAYERS + 1]
new g_TrPartner[MAX_PLAYERS + 1]
new Float:g_TrUntil[MAX_PLAYERS + 1]            // an invitation lapses at this game time
new g_OfCell[MAX_PLAYERS + 1][TR_CELLS]         // the cell an entry holds (-1: the entry is free)
new g_OfN[MAX_PLAYERS + 1][TR_CELLS]
new g_OfKind[MAX_PLAYERS + 1][TR_CELLS]         // what the entry was made of: an entry that no longer matches its cell fails the check
new g_OfMoney[MAX_PLAYERS + 1]
new g_Sealed[MAX_PLAYERS + 1]
new Float:g_LockUntil[MAX_PLAYERS + 1]
new Float:g_TrChanged[MAX_PLAYERS + 1]          // when the offer last changed (the idle time-out)
new Float:g_InviteAt[MAX_PLAYERS + 1]
new g_CoolWith[MAX_PLAYERS + 1]
new Float:g_CoolUntil[MAX_PLAYERS + 1]

// the swap is worked out on copies and, when it fits, becomes the cells
new g_SimK[2][INV_MAX_CELLS]
new g_SimN[2][INV_MAX_CELLS]
new g_ZeroRes[INV_MAX_CELLS]

// the stack limit of each kind that inventory.ini names (0: arp_h9_inv_stack)
new g_StackOf[INV_MAX_KINDS + 1]

// the last values of the cvars the one second pass looks at
new g_LastSlots = -1
new g_LastStack = -1

// the arrangement in the database (the persistence part, below): what each player's row is, and what is known of it
new g_DbKey[MAX_PLAYERS + 1][36]                // the character key his row is kept under, as it was when he loaded ("": nothing is read or written for him)
new g_DbSig[MAX_PLAYERS + 1]                    // a signature of the cells as the database holds them (0: unknown, so what he has is to be written)
new g_DbJoinSig[MAX_PLAYERS + 1]                // the signature of the cells as a join packed them: a change since then wins over a saved arrangement
new g_DbSeq[MAX_PLAYERS + 1]                    // the count of his loads, so that the answer to an old one is ignored
new g_DbPending[MAX_PLAYERS + 1]                // his saved arrangement has been asked for and has not come
new g_DbSeen[MAX_PLAYERS + 1]                   // the signature of the last pass that found his cells changed, when that began and when it last changed
new Float:g_DbSince[MAX_PLAYERS + 1]
new Float:g_DbLast[MAX_PLAYERS + 1]
new g_DbTable[40] = "arp_h9_cells"
new g_DbMade                                    // the table is there
new Float:g_DbFailUntil                         // after a query failed nothing is tried before this game time
new g_DbWrites                                  // how many writes, reads and laid-over arrangements since the map began (arp_h9_inv_dump says)
new g_DbReads
new g_DbApplied

// ---------------------------------------------------------------------------------------------------------------------- cvars and the limits

// the cells a player has: 0 for no limit, else 8 to 96
stock inv_slots()
{
	new n = get_pcvar_num(p_Slots)

	return n < 1 ? 0 : clamp(n,INV_MIN_SLOTS,INV_MAX_SLOTS)
}

// the cells new items may be put in: the limit, or all that can be made when there is none
stock inv_cap()
{
	new n = inv_slots()

	return n ? n : INV_MAX_CELLS
}

// how many of a kind one cell holds
stock inv_stackmax(kind)
{
	new n
	if(kind > 0 && kind <= INV_MAX_KINDS)
		n = g_StackOf[kind]

	if(n < 1)
		n = get_pcvar_num(p_Stack)

	return clamp(n,1,INV_MAX_STACK)
}

// ---------------------------------------------------------------------------------------------------------------------- the cells (arrays in, arrays out)

// the first empty cell below cap, or -1
stock inv_first_empty(const ck[],cap)
{
	for(new c;c < cap && c < INV_MAX_CELLS;c++)
		if(!ck[c])
			return c

	return -1
}

// the cells that hold something
stock inv_used(const ck[])
{
	new n
	for(new c;c < INV_MAX_CELLS;c++)
		if(ck[c])
			n++

	return n
}

// the highest cell that holds something, plus one (0: none)
stock inv_last(const ck[])
{
	for(new c = INV_MAX_CELLS - 1;c >= 0;c--)
		if(ck[c])
			return c + 1

	return 0
}

// the cells a new kind may be put in: the empty cells below cap, and no more than cap less the cells in use (a player over his limit has none)
stock inv_free(const ck[],cap)
{
	new empties,used
	for(new c;c < INV_MAX_CELLS;c++)
	{
		if(ck[c])
			used++
		else if(c < cap)
			empties++
	}

	return max(0,min(empties,cap - used))
}

// the count of a kind over all the cells
stock inv_have(const ck[],const cn[],kind)
{
	new n
	for(new c;c < INV_MAX_CELLS;c++)
		if(ck[c] == kind)
			n += cn[c]

	return n
}

// ROOM: how many of a kind fit: the room left in its partial stacks (a reserved cell is not filled) and a whole stack for each free cell
stock inv_room(const ck[],const cn[],const res[],kind,cap)
{
	new sm = inv_stackmax(kind),room = inv_free(ck,cap) * sm
	for(new c;c < INV_MAX_CELLS;c++)
		if(ck[c] == kind && !res[c] && cn[c] < sm)
			room += sm - cn[c]

	return room
}

// puts qty of a kind in: the partial stacks in cell order, then empty cells in cell order; no more than fits. Returns how many went in.
stock inv_place(ck[],cn[],const res[],kind,qty,cap)
{
	new sm = inv_stackmax(kind),left = min(qty,inv_room(ck,cn,res,kind,cap)),placed = left

	for(new c;c < INV_MAX_CELLS && left > 0;c++)
	{
		if(ck[c] != kind || res[c] || cn[c] >= sm)
			continue

		new put = min(sm - cn[c],left)
		cn[c] += put
		left -= put
	}

	while(left > 0)
	{
		new c = inv_first_empty(ck,cap)
		if(c < 0)
			break

		new put = min(sm,left)
		ck[c] = kind
		cn[c] = put
		left -= put
	}

	return placed - left
}

// takes up to qty of a kind away: from the cell prefer first, then from the highest cell of the kind downward (a reserved cell last of all). Returns how many.
stock inv_take(ck[],cn[],res[],kind,qty,prefer)
{
	new left = qty

	if(prefer >= 0 && prefer < INV_MAX_CELLS && ck[prefer] == kind)
	{
		new t = min(left,cn[prefer])
		cn[prefer] -= t
		left -= t
		if(!cn[prefer])
			ck[prefer] = 0

		res[prefer] = min(res[prefer],cn[prefer])
	}

	for(new pass;pass < 2 && left > 0;pass++)
	{
		for(new c = INV_MAX_CELLS - 1;c >= 0 && left > 0;c--)
		{
			if(ck[c] != kind || (!pass && res[c]))
				continue

			new t = min(left,cn[c])
			cn[c] -= t
			left -= t
			if(!cn[c])
				ck[c] = 0

			res[c] = min(res[c],cn[c])
		}
	}

	return qty - left
}

// puts qty of a kind in whatever it takes, past the limit of cells and the stack limit: empty cells wherever they are, else on top of a cell of the kind.
// For what must not be lost. Returns how many went in (all of it unless there is neither an empty cell nor a cell of the kind).
stock inv_fat(ck[],cn[],kind,qty)
{
	new sm = inv_stackmax(kind),left = qty

	for(new c;c < INV_MAX_CELLS && left > 0;c++)
	{
		if(ck[c])
			continue

		new put = min(sm,left)
		ck[c] = kind
		cn[c] = put
		left -= put
	}

	for(new c = INV_MAX_CELLS - 1;c >= 0 && left > 0;c--)
	{
		if(ck[c] != kind)
			continue

		cn[c] += left
		left = 0
	}

	return qty - left
}

// ---------------------------------------------------------------------------------------------------------------------- words

// 1250 -> 1,250
stock inv_commas(num,out[],len)
{
	new s[16],n = num < 0 ? -num : num,p
	num_to_str(n,s,15)

	new l = strlen(s)
	if(num < 0 && p < len - 1)
		out[p++] = '-'

	for(new i;i < l && p < len - 1;i++)
	{
		if(i > 0 && (l - i) % 3 == 0 && p < len - 1)
			out[p++] = ','

		if(p < len - 1)
			out[p++] = s[i]
	}

	out[p] = 0
}

// the money as a sentence says it to a player (id 0: a log, which never has the sign): with arp_h9_credits 1 "1,250 credits", and the credit sign and the
// digits to a player who is shown it (ApolloRP_Credits.inc): as the single byte a panel draws when the text is for a panel (a window), else "$1,250", which
// client_print turns into the sign; with arp_h9_credits 0 "$1,250"
stock inv_money(id,amount,out[],len,bool:panel = false)
{
	new c[24]
	inv_commas(amount,c,23)

	if(!get_pcvar_num(p_Credits))
		formatex(out,len - 1,"$%s",c)
	else if(!arp_credit_sign(id))
		formatex(out,len - 1,"%s credit%s",c,amount == 1 ? "" : "s")
	else if(panel)
		formatex(out,len - 1,"^xA2;%s",c)
	else
		formatex(out,len - 1,"$%s",c)
}

// ASCII only (and the single byte of the credit sign), and nothing the client's printf or the engine's string handling would act on
stock inv_clean(const src[],dst[],len)
{
	new i
	for(;src[i] && i < len - 1;i++)
		dst[i] = ((src[i] < 32 || src[i] > 126) && src[i] != ARP_CREDIT_BYTE) || src[i] == '%' || src[i] == '^^' ? '?' : src[i]

	dst[i] = 0
}

// ---------------------------------------------------------------------------------------------------------------------- who has the window

// the cells shown: the limit, or what the player's cells need when he is over it; with no limit, the grid grows to what is needed in rows of 8
stock inv_shown(id)
{
	new slots = inv_slots(),last = inv_last(g_CK[id]),shown

	if(slots)
	{
		shown = slots
		if(last > slots)
			shown = ((last + 7) / 8) * 8
	}
	else
		shown = max(INV_GRID_MIN,((last + 7) / 8) * 8)

	return min(shown,INV_MAX_CELLS)
}

// the OPEN flags: bit 0 over capacity, bit 1 no limit of cells, bit 2 the money is called credits
stock inv_flags(id)
{
	new slots = inv_slots(),flags

	if(slots && inv_last(g_CK[id]) > slots)
		flags |= 1

	if(!slots)
		flags |= 2

	if(get_pcvar_num(p_Credits))
		flags |= 4

	return flags
}

// whether this player's game has the inventory window and the server gives it: his character is loaded, a game that draws H9Inv (not a bot),
// arp_h9_inv_window, and the player's and the server's wish for Apollo RP's panels (arp_h9_vgui, cl_h9_arpvgui)
stock bool:inv_window(id)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id] || g_MsgInv <= 0 || !is_user_connected(id) || is_user_bot(id))
		return false

	if(!get_pcvar_num(p_Window))
		return false

	if(h9vgui_protocol(id) < H9VGUI_INV_PROTOCOL)
		return false

	return arpvgui_wanted(id)
}

// ---------------------------------------------------------------------------------------------------------------------- the messages

// never more than 12 messages to a player in one frame: true when one more may go now (11 at most)
stock bool:inv_budget(id)
{
	new Float:now = get_gametime()
	if(now != g_FrameAt[id])
	{
		g_FrameAt[id] = now
		g_FrameMsgs[id] = 0
	}

	if(g_FrameMsgs[id] >= 11)
		return false

	g_FrameMsgs[id]++

	return true
}

stock inv_begin(id)
	engfunc(EngFunc_MessageBegin,MSG_ONE,g_MsgInv,Float:{0.0,0.0,0.0},id)

// an item's name as the protocol carries it
stock inv_item_name(kind,out[],len)
{
	new raw[33]
	if(kind > 0 && ARP_ValidItemId(kind))
		ARP_GetItemName(kind,raw,32)
	else
		copy(raw,32,"?")

	inv_clean(raw,out,len)
}

// OPEN: byte op, byte flags, short cells shown, long wallet, long bank, string name, string job
inv_send_open(id)
{
	new raw[33],name[INV_NAME_LEN],job[INV_NAME_LEN]
	get_user_name(id,raw,32)
	inv_clean(raw,name,INV_NAME_LEN)

	new JobId = ARP_GetUserJobId(id)
	if(ARP_ValidJobId(JobId))
	{
		ARP_GetJobName(JobId,raw,32)
		inv_clean(raw,job,INV_NAME_LEN)
	}

	inv_begin(id)
	write_byte(INV_OP_OPEN)
	write_byte(inv_flags(id))
	write_short(inv_shown(id))
	write_long(max(0,ARP_GetUserWallet(id)))
	write_long(max(0,ARP_GetUserBank(id)))
	write_string(name)
	write_string(job)
	message_end()
}

// CATALOG: byte op, byte n, then n of { short kind, short stack limit, byte 0, string name }; as many messages as the kinds need.
// Returns how many kinds were sent (fewer than n only when the frame's messages ran out).
inv_send_catalog(id,const kinds[],n)
{
	new i

	while(i < n)
	{
		new first = i,size = 2,fit,name[INV_NAME_LEN]

		while(i < n)
		{
			inv_item_name(kinds[i],name,INV_NAME_LEN)

			new entry = 2 + 2 + 1 + strlen(name) + 1
			if(fit > 0 && size + entry > INV_MSG_MAX)
				break

			size += entry
			fit++
			i++
		}

		if(!inv_budget(id))
			return first

		inv_begin(id)
		write_byte(INV_OP_CATALOG)
		write_byte(fit)
		for(new k = first;k < first + fit;k++)
		{
			inv_item_name(kinds[k],name,INV_NAME_LEN)

			write_short(kinds[k])
			write_short(inv_stackmax(kinds[k]))
			write_byte(0)
			write_string(name)

			g_CatSent[id][kinds[k]] = 1
		}
		message_end()
	}

	return n
}

// SLOTS: byte op, short first cell, byte count, then count of { short kind, short n }
inv_send_slots(id,first,count)
{
	inv_begin(id)
	write_byte(INV_OP_SLOTS)
	write_short(first)
	write_byte(count)
	for(new c = first;c < first + count;c++)
	{
		write_short(g_CK[id][c])
		write_short(min(g_CN[id][c],32767))

		g_SK[id][c] = g_CK[id][c]
		g_SN[id][c] = g_CN[id][c]
	}
	message_end()
}

// MONEY: byte op, long wallet, long bank
inv_send_money(id,wallet,bank)
{
	inv_begin(id)
	write_byte(INV_OP_MONEY)
	write_long(max(0,wallet))
	write_long(max(0,bank))
	message_end()

	g_SentWallet[id] = wallet
	g_SentBank[id] = bank
	g_MoneyAt[id] = get_gametime()
}

// DESC: byte op, short kind, string text
stock inv_send_desc(id,kind,const text[])
{
	if(!inv_budget(id))
		return

	new clean[121]
	inv_clean(text,clean,121)

	inv_begin(id)
	write_byte(INV_OP_DESC)
	write_short(kind)
	write_string(clean)
	message_end()
}

// NOTE: byte op, byte level (0 plain, 1 warning), string text
stock inv_send_note(id,level,const text[])
{
	if(!inv_budget(id))
		return

	new clean[121]
	inv_clean(text,clean,121)

	inv_begin(id)
	write_byte(INV_OP_NOTE)
	write_byte(level)
	write_string(clean)
	message_end()
}

// CLOSE: byte op. Never held back.
stock inv_send_close(id)
{
	inv_begin(id)
	write_byte(INV_OP_CLOSE)
	message_end()
}

// RESERVE: byte op, short first cell, byte count, then count of { short n }: the count of each cell an open exchange holds
inv_send_reserve(id,first,count)
{
	inv_begin(id)
	write_byte(INV_OP_RESERVE)
	write_short(first)
	write_byte(count)
	for(new c = first;c < first + count;c++)
	{
		write_short(g_Res[id][c])

		g_SR[id][c] = g_Res[id][c]
	}
	message_end()
}

// ---------------------------------------------------------------------------------------------------------------------- what the window is told

// a line for the player about his items: the window's status row when it is open, chat when it is not. A game that has the window is always
// sent the NOTE (a closed window ignores it).
stock inv_note(id,level,const text[])
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
		return

	if(inv_window(id))
		inv_send_note(id,level,text)

	if(!g_Open[id])
		client_print(id,print_chat,"[ARP] %s",text)
}

// a refusal: the line, level 1; returns 1 for the caller to return
stock inv_deny(id,const text[])
{
	inv_note(id,1,text)

	return 1
}

// an open window that is due a flush gets one soon
stock inv_kick_one(id)
{
	if(!g_Open[id] || g_FlushTask[id])
		return

	g_FlushTask[id] = 1
	set_task(0.05,"inv_task_flush",INV_TASK_FLUSH + id)
}

// the player's window, and the window of whoever is searching him (he is sent the change of his cells)
stock inv_kick(id)
{
	if(id >= 1 && id <= MAX_PLAYERS && g_SrBy[id] && g_SrBy[id] != id)
		inv_kick_one(g_SrBy[id])

	inv_kick_one(id)
}

public inv_task_flush(taskid)
{
	new id = taskid - INV_TASK_FLUSH
	if(id < 1 || id > MAX_PLAYERS)
		return

	g_FlushTask[id] = 0
	inv_flush(id)
}

// the window is shut: by the player (nothing is sent) or by the server (the client is told)
stock inv_close(id,tell)
{
	if(id < 1 || id > MAX_PLAYERS || !g_Open[id])
		return

	// the window the search is drawn beside is gone: so is the search (the game is told when the server did it)
	if(g_SrTarget[id])
		sr_end(id,tell ? SR_GONE : -1)

	g_Open[id] = 0
	g_PendOpen[id] = 0

	if(tell && is_user_connected(id) && g_MsgInv > 0 && h9vgui_protocol(id) >= H9VGUI_INV_PROTOCOL)
		inv_send_close(id)
}

// sends an open window what it lacks: the header when it changed or was asked for, the cells that differ from what it was sent (the catalog of the kinds
// it does not know first), the money, and the reserve. At most maxmsgs messages; what is left is sent a moment later.
inv_flush(id,maxmsgs = 6)
{
	if(id < 1 || id > MAX_PLAYERS || !g_Open[id])
		return

	if(!is_user_connected(id) || !inv_window(id))
	{
		inv_close(id,1)
		return
	}

	new sent,bool:more,shown = inv_shown(id),flags = inv_flags(id)

	if(shown != g_SentShown[id] || flags != g_SentFlags[id])
		g_PendOpen[id] = 1

	if(g_PendOpen[id])
	{
		if(!inv_budget(id))
		{
			inv_kick(id)
			return
		}

		inv_send_open(id)
		sent++

		g_PendOpen[id] = 0
		g_SentShown[id] = shown
		g_SentFlags[id] = flags
		g_SentWallet[id] = ARP_GetUserWallet(id)
		g_SentBank[id] = ARP_GetUserBank(id)
		g_MoneyAt[id] = get_gametime()

		for(new c;c < INV_MAX_CELLS;c++)
		{
			g_SK[id][c] = -1
			g_SN[id][c] = 0
			g_SR[id][c] = inv_exchange_open(id) ? -1 : 0
		}

		for(new k;k <= INV_MAX_KINDS;k++)
			g_CatSent[id][k] = 0

		// the catalog is told again, so the cells of the player he is searching are sent again with it
		if(g_SrTarget[id])
			g_SrPending[id] = 1
	}

	// the cells that differ from what he was sent, a run at a time
	new c
	while(c < shown)
	{
		if(g_CK[id][c] == g_SK[id][c] && g_CN[id][c] == g_SN[id][c])
		{
			c++
			continue
		}

		if(sent >= maxmsgs)
		{
			more = true
			break
		}

		new first = c,count
		while(c < shown && count < INV_SLOTS_CHUNK && (g_CK[id][c] != g_SK[id][c] || g_CN[id][c] != g_SN[id][c]))
		{
			count++
			c++
		}

		// the kinds of this run that he does not know yet
		new need[INV_SLOTS_CHUNK],needs
		for(new k = first;k < first + count;k++)
		{
			new kind = g_CK[id][k]
			if(kind < 1 || kind > INV_MAX_KINDS || g_CatSent[id][kind])
				continue

			new known
			for(new j;j < needs;j++)
				if(need[j] == kind)
					known = 1

			if(!known)
				need[needs++] = kind
		}

		if(needs)
		{
			new done = inv_send_catalog(id,need,needs)
			sent += (done + 3) / 4

			if(done < needs)
			{
				more = true
				break
			}
		}

		if(!inv_budget(id))
		{
			more = true
			break
		}

		inv_send_slots(id,first,count)
		sent++
	}

	// the reserve of an open exchange
	if(!more && sent < maxmsgs)
	{
		new r
		while(r < shown && !more)
		{
			if(g_Res[id][r] == g_SR[id][r])
			{
				r++
				continue
			}

			if(!inv_budget(id))
			{
				more = true
				break
			}

			new first = r,count
			while(r < shown && count < INV_SLOTS_CHUNK && g_Res[id][r] != g_SR[id][r])
			{
				count++
				r++
			}

			inv_send_reserve(id,first,count)
			sent++
		}
	}

	// the money, when it changed and a quarter of a second has gone since it was sent
	if(!more)
	{
		new wallet = ARP_GetUserWallet(id),bank = ARP_GetUserBank(id)
		if((wallet != g_SentWallet[id] || bank != g_SentBank[id]) && get_gametime() - g_MoneyAt[id] >= 0.25 && inv_budget(id))
			inv_send_money(id,wallet,bank)
	}

	// the cells of the player he is searching, when his own have all gone
	if(!more)
		sr_flush(id)

	if(more)
		inv_kick(id)
}

// ---------------------------------------------------------------------------------------------------------------------- one player's cells

// the highest count over a kind's stack limit in the player's cells is not allowed to stand unless a limit was lowered; this keeps g_Over right
stock inv_set_over(id)
{
	new over
	for(new c;c < INV_MAX_CELLS;c++)
		if(g_CK[id][c] && g_CN[id][c] > inv_stackmax(g_CK[id][c]))
			over = 1

	g_Over[id] = over
}

// forgets everything about a player's arrangement and his window
stock inv_reset(id)
{
	sr_reset(id)

	g_On[id] = 0
	g_Over[id] = 0
	g_Lost[id] = 0
	g_Repairs[id] = 0
	g_Open[id] = 0
	g_PendOpen[id] = 0
	g_FlushTask[id] = 0
	g_ActKind[id] = 0
	g_ActCell[id] = -1
	g_UseKind[id] = 0
	g_UseCell[id] = -1
	g_UseSlack[id] = 0
	g_Self[id] = 0
	g_SentShown[id] = 0
	g_SentFlags[id] = 0
	g_CmdCount[id] = 0
	g_CmdAt[id] = 0.0
	g_InviteAt[id] = 0.0
	g_CoolWith[id] = 0
	g_CoolUntil[id] = 0.0
	tr_clear(id)

	for(new c;c < INV_MAX_CELLS;c++)
	{
		g_CK[id][c] = 0
		g_CN[id][c] = 0
		g_Res[id][c] = 0
		g_SK[id][c] = -1
		g_SN[id][c] = 0
		g_SR[id][c] = 0
	}

	for(new k;k <= INV_MAX_KINDS;k++)
		g_CatSent[id][k] = 0

	remove_task(INV_TASK_FLUSH + id)
}

// the cells of a player made again from his items: kinds in item order, each in full stacks and then the remainder, from cell 0. Nothing is cut: more
// than the limit of cells is kept (over capacity), and only more than INV_MAX_CELLS cells can leave something out (g_Lost).
stock inv_pack(id)
{
	for(new c;c < INV_MAX_CELLS;c++)
	{
		g_CK[id][c] = 0
		g_CN[id][c] = 0
		g_Res[id][c] = 0
	}

	g_Over[id] = 0
	g_Lost[id] = 0

	if(!is_user_connected(id))
		return

	for(new kind = 1;kind <= INV_MAX_KINDS && ARP_ValidItemId(kind);kind++)
	{
		new total = ARP_GetUserItemNum(id,kind)
		if(total < 1)
			continue

		new placed = inv_place(g_CK[id],g_CN[id],g_Res[id],kind,total,INV_MAX_CELLS)
		if(placed < total)
		{
			new fat = inv_fat(g_CK[id],g_CN[id],kind,total - placed)
			g_Lost[id] += total - placed - fat
			g_Over[id] = 1
		}
	}

	if(g_Lost[id])
		log_amx("[ARP] inventory: %d items of player %d did not fit in %d cells and are not shown",g_Lost[id],id,INV_MAX_CELLS)

	inv_set_over(id)
	inv_kick(id)
}

// the cells and the count of a kind disagree: the cells are made to say the count (the core's count is the truth)
stock inv_repair(id,kind,total,have)
{
	new name[INV_NAME_LEN]
	inv_item_name(kind,name,INV_NAME_LEN)

	g_Repairs[id]++
	log_amx("[ARP] inventory: the cells of player %d held %d of %s (item %d) where the count is %d: corrected",id,have,name,kind,total)

	if(have < total)
	{
		new placed = inv_place(g_CK[id],g_CN[id],g_Res[id],kind,total - have,INV_MAX_CELLS)
		if(placed < total - have)
			inv_fat(g_CK[id],g_CN[id],kind,total - have - placed)
	}
	else
		inv_take(g_CK[id],g_CN[id],g_Res[id],kind,have - total,-1)
}

// after a limit changed: a stack that is over a lowered stack limit is split into empty cells (what cannot be split stays whole: over capacity), and cells that
// lie beyond a lowered limit of cells are brought into empty cells inside it
stock inv_normalize(id)
{
	new cap = inv_cap()

	for(new c;c < INV_MAX_CELLS;c++)
	{
		new kind = g_CK[id][c]
		if(!kind || g_Res[id][c])
			continue

		new sm = inv_stackmax(kind)
		while(g_CN[id][c] > sm)
		{
			new t = inv_first_empty(g_CK[id],cap)
			if(t < 0 || t == c)
				break

			new put = min(sm,g_CN[id][c] - sm)
			g_CK[id][t] = kind
			g_CN[id][t] = put
			g_CN[id][c] -= put
		}
	}

	for(new c = cap;c < INV_MAX_CELLS;c++)
	{
		if(!g_CK[id][c] || g_Res[id][c])
			continue

		new t = inv_first_empty(g_CK[id],cap)
		if(t < 0)
			break

		g_CK[id][t] = g_CK[id][c]
		g_CN[id][t] = g_CN[id][c]
		g_CK[id][c] = 0
		g_CN[id][c] = 0
	}

	inv_set_over(id)
	inv_kick(id)
}

// the cell the player's action names for a kind, or -1: the count the core takes is taken from it first
stock inv_prefer(id,kind)
{
	if(g_UseKind[id] == kind && g_UseCell[id] >= 0)
		return g_UseCell[id]

	if(g_ActKind[id] == kind)
		return g_ActCell[id]

	return -1
}

// ---------------------------------------------------------------------------------------------------------------------- the core's questions (ARP_InvOnCount, OnRoom, OnUse, OnNote)

// a count of a player's items is about to become newnum: arranges the cells to it and returns the count to keep
stock inv_count_changed(id,kind,oldnum,newnum)
{
	if(newnum < 0)
		newnum = 0

	if(g_Self[id] || kind < 1 || kind > INV_MAX_KINDS)
		return newnum

	new have = inv_have(g_CK[id],g_CN[id],kind)
	if(have != oldnum)
		inv_repair(id,kind,oldnum,have)

	if(newnum == oldnum)
		return newnum

	if(newnum < oldnum)
	{
		inv_take(g_CK[id],g_CN[id],g_Res[id],kind,oldnum - newnum,inv_prefer(id,kind))
		inv_set_over(id)
		inv_kick(id)

		return newnum
	}

	return oldnum + inv_added(id,kind,newnum - oldnum)
}

// qty more of a kind arrive: what fits is put in the cells; the rest is kept as slack while the kind is being used (a handler gave the unit back), else it is
// a pack at the player's feet, else (no pack can be made, or the cells have no limit) it is kept over the limit. Returns how many are kept.
stock inv_added(id,kind,qty)
{
	new slots = inv_slots(),placed = inv_place(g_CK[id],g_CN[id],g_Res[id],kind,qty,inv_cap()),over = qty - placed

	if(over > 0)
	{
		if(!slots)
		{
			inv_fat(g_CK[id],g_CN[id],kind,over)
			placed += over
		}
		else if(g_UseKind[id] == kind)
		{
			new t = g_UseCell[id]
			if(t < 0 || g_CK[id][t] != kind)
				for(new c;c < INV_MAX_CELLS;c++)
					if(g_CK[id][c] == kind)
					{
						t = c
						break
					}

			if(t >= 0 && g_CK[id][t] == kind)
			{
				g_CN[id][t] += over
				g_UseSlack[id] += over
			}
			else
				inv_fat(g_CK[id],g_CN[id],kind,over)

			placed += over
		}
		else if(ARP_DropPack(id,kind,over))
		{
			new name[INV_NAME_LEN],text[128]
			inv_item_name(kind,name,INV_NAME_LEN)
			formatex(text,127,"Your inventory is full: %d %s fell at your feet.",over,name)
			inv_note(id,1,text)
		}
		else
		{
			inv_fat(g_CK[id],g_CN[id],kind,over)
			placed += over
		}
	}

	inv_set_over(id)
	inv_kick(id)

	return placed
}

// an item's use is over: what a handler gave back to a full cell and the use did not take away again does not stay over the stack limit
stock inv_settle(id,kind)
{
	if(g_UseSlack[id] < 1)
		return

	new sm = inv_stackmax(kind),excess
	for(new c;c < INV_MAX_CELLS && excess < g_UseSlack[id];c++)
	{
		if(g_CK[id][c] != kind || g_CN[id][c] <= sm)
			continue

		new t = min(g_CN[id][c] - sm,g_UseSlack[id] - excess)
		g_CN[id][c] -= t
		excess += t
	}

	if(excess < 1)
		return

	new placed = inv_place(g_CK[id],g_CN[id],g_Res[id],kind,excess,inv_cap()),rest = excess - placed
	if(rest > 0)
	{
		if(ARP_DropPack(id,kind,rest))
		{
			// the pack holds what leaves the count
			g_Self[id]++
			ARP_SetUserItemNum(id,kind,max(0,ARP_GetUserItemNum(id,kind) - rest))
			g_Self[id]--

			new name[INV_NAME_LEN],text[128]
			inv_item_name(kind,name,INV_NAME_LEN)
			formatex(text,127,"Your inventory is full: %d %s fell at your feet.",rest,name)
			inv_note(id,1,text)
		}
		else
			inv_fat(g_CK[id],g_CN[id],kind,rest)
	}

	inv_set_over(id)
	inv_kick(id)
}

// ---------------------------------------------------------------------------------------------------------------------- the operations of the window

// the cells shown, or 0 when the player has no arrangement to act on
stock inv_cells(id)
	return g_On[id] ? inv_shown(id) : 0

// MOVE a cell to another: an empty one takes it, a cell of the same kind is combined with (as much as fits, the rest stays), another kind swaps
stock inv_op_move(id,f,t)
{
	new shown = inv_cells(id)
	if(f < 0 || t < 0 || f >= shown || t >= shown)
		return inv_deny(id,"There is no such cell.")

	if(f == t)
		return inv_deny(id,"That is the same cell.")

	new kf = g_CK[id][f],kt = g_CK[id][t]
	if(!kf)
		return inv_deny(id,"That cell is empty.")

	if(g_Res[id][f] || g_Res[id][t])
		return inv_deny(id,"That is in your exchange.")

	if(!kt)
	{
		g_CK[id][t] = kf
		g_CN[id][t] = g_CN[id][f]
		g_CK[id][f] = 0
		g_CN[id][f] = 0
	}
	else if(kt == kf)
	{
		new moved = min(g_CN[id][f],max(0,inv_stackmax(kf) - g_CN[id][t]))
		if(moved < 1)
			return inv_deny(id,"That stack is full.")

		g_CN[id][t] += moved
		g_CN[id][f] -= moved
		if(!g_CN[id][f])
			g_CK[id][f] = 0
	}
	else
	{
		new n = g_CN[id][f]
		g_CK[id][f] = kt
		g_CN[id][f] = g_CN[id][t]
		g_CK[id][t] = kf
		g_CN[id][t] = n
	}

	inv_set_over(id)
	inv_kick(id)

	return 0
}

// SPLIT n off a cell into an empty one (to: the cell, or -1 for the first empty cell)
stock inv_op_split(id,s,n,to)
{
	new shown = inv_cells(id)
	if(s < 0 || s >= shown)
		return inv_deny(id,"There is no such cell.")

	if(!g_CK[id][s])
		return inv_deny(id,"That cell is empty.")

	if(g_Res[id][s])
		return inv_deny(id,"That is in your exchange.")

	if(n < 1 || n >= g_CN[id][s])
		return inv_deny(id,"That cannot be split.")

	new t = to
	if(t < 0)
	{
		t = inv_first_empty(g_CK[id],inv_cap())
		if(t < 0)
			return inv_deny(id,"Your inventory is full.")
	}
	else if(t >= shown || g_CK[id][t] || t == s)
		return inv_deny(id,"That cell is not empty.")

	g_CK[id][t] = g_CK[id][s]
	g_CN[id][t] = n
	g_CN[id][s] -= n

	inv_set_over(id)
	inv_kick(id)

	return 0
}

// TIDY: every kind's stacks merged (full stacks first) and packed to the front in item order; a cell an exchange holds stays where it is
stock inv_op_tidy(id)
{
	if(!g_On[id])
		return 1

	new tot[INV_MAX_KINDS + 1],bk[INV_MAX_CELLS],bn[INV_MAX_CELLS]

	for(new c;c < INV_MAX_CELLS;c++)
	{
		bk[c] = g_CK[id][c]
		bn[c] = g_CN[id][c]

		if(g_CK[id][c] && !g_Res[id][c])
		{
			tot[g_CK[id][c]] += g_CN[id][c]
			g_CK[id][c] = 0
			g_CN[id][c] = 0
		}
	}

	new pos,lost
	for(new kind = 1;kind <= INV_MAX_KINDS;kind++)
	{
		new left = tot[kind],sm = inv_stackmax(kind)

		while(left > 0)
		{
			while(pos < INV_MAX_CELLS && g_CK[id][pos])
				pos++

			if(pos >= INV_MAX_CELLS)
			{
				lost += left - inv_fat(g_CK[id],g_CN[id],kind,left)
				break
			}

			new put = min(sm,left)
			g_CK[id][pos] = kind
			g_CN[id][pos] = put
			left -= put
			pos++
		}
	}

	if(lost)
	{
		// not a cell left to put it in: the arrangement stays as it was
		for(new c;c < INV_MAX_CELLS;c++)
		{
			g_CK[id][c] = bk[c]
			g_CN[id][c] = bn[c]
		}

		return inv_deny(id,"The cells cannot be tidied.")
	}

	inv_set_over(id)
	inv_kick(id)

	return 0
}

// the answer of the core's item paths, in words (0: done)
stock inv_say_result(id,rc)
{
	switch(rc)
	{
		case ARP_ITEM_NONE :
			return inv_deny(id,"You do not have that.")
		case ARP_ITEM_BUSY :
			return inv_deny(id,"You are already using another item.")
		case ARP_ITEM_INVALID :
			return inv_deny(id,"That cannot be done.")
		case ARP_ITEM_NOPACK :
			return inv_deny(id,"You cannot drop items right now.")
	}

	return rc
}

// USE the item in a cell, through ARP's own path (the Item_Use event, the g_ItemUse mutex, the item's handler)
stock inv_op_use(id,cell)
{
	new shown = inv_cells(id)
	if(cell < 0 || cell >= shown)
		return inv_deny(id,"There is no such cell.")

	new kind = g_CK[id][cell]
	if(!kind)
		return inv_deny(id,"That cell is empty.")

	if(g_Res[id][cell])
		return inv_deny(id,"That is in your exchange.")

	g_ActKind[id] = kind
	g_ActCell[id] = cell
	new rc = ARP_UserUseItem(id,kind)
	g_ActKind[id] = 0
	g_ActCell[id] = -1

	return inv_say_result(id,rc)
}

// DROP n of the item in a cell as a pack on the floor, through ARP's own path (the Item_Drop event); the cell gives it up once the pack exists
stock inv_op_drop(id,cell,n)
{
	new shown = inv_cells(id)
	if(cell < 0 || cell >= shown)
		return inv_deny(id,"There is no such cell.")

	new kind = g_CK[id][cell]
	if(!kind)
		return inv_deny(id,"That cell is empty.")

	if(g_Res[id][cell])
		return inv_deny(id,"That is in your exchange.")

	if(n < 1 || n > g_CN[id][cell])
		return inv_deny(id,"That is not what the cell holds.")

	g_ActKind[id] = kind
	g_ActCell[id] = cell
	new rc = ARP_UserDropItem(id,kind,n)
	g_ActKind[id] = 0
	g_ActCell[id] = -1

	return inv_say_result(id,rc)
}

// whether another player is one the player may give to or show to: alive, a person, near and in sight
stock inv_near(id,target,Float:range)
{
	if(target < 1 || target > MAX_PLAYERS || target == id || !is_user_connected(target) || !is_user_alive(target))
		return 0

	if(is_user_bot(target) || float(get_entity_distance(id,target)) > range)
		return 0

	new Float:eyes[3],Float:ofs[3],Float:there[3],Float:fraction
	pev(id,pev_origin,eyes)
	pev(id,pev_view_ofs,ofs)
	eyes[0] += ofs[0]
	eyes[1] += ofs[1]
	eyes[2] += ofs[2]
	pev(target,pev_origin,there)

	engfunc(EngFunc_TraceLine,eyes,there,0,id)
	global_get(glb_trace_fraction,fraction)

	return fraction >= 1.0 || global_get(glb_trace_ent) == target
}

// GIVE n of the item in a cell to a player near, through ARP's own path (the Item_Give event): all of it or none
stock inv_op_give(id,cell,n,target)
{
	new shown = inv_cells(id)
	if(cell < 0 || cell >= shown)
		return inv_deny(id,"There is no such cell.")

	new kind = g_CK[id][cell]
	if(!kind)
		return inv_deny(id,"That cell is empty.")

	if(g_Res[id][cell])
		return inv_deny(id,"That is in your exchange.")

	if(n < 1 || n > g_CN[id][cell])
		return inv_deny(id,"That is not what the cell holds.")

	if(!inv_near(id,target,INV_GIVE_RANGE))
		return inv_deny(id,"That player is not near enough.")

	g_ActKind[id] = kind
	g_ActCell[id] = cell
	new rc = ARP_UserGiveItem(id,target,kind,n)
	g_ActKind[id] = 0
	g_ActCell[id] = -1

	if(rc == ARP_ITEM_FULL)
	{
		new name[33],text[96]
		get_user_name(target,name,32)
		formatex(text,95,"%s's inventory is full.",name)

		return inv_deny(id,text)
	}

	return inv_say_result(id,rc)
}

// SHOW the item in a cell to a player near, through ARP's own path (the Item_Show event first, then the chat lines); nothing changes hands. The target is
// shown the item as a banner, in any game, and the shower is told in his window.
stock inv_op_show(id,cell,target)
{
	new shown = inv_cells(id)
	if(cell < 0 || cell >= shown)
		return inv_deny(id,"There is no such cell.")

	new kind = g_CK[id][cell]
	if(!kind)
		return inv_deny(id,"That cell is empty.")

	if(!inv_near(id,target,INV_SHOW_RANGE))
		return inv_deny(id,"That player is not near enough.")

	new rc = ARP_UserShowItem(id,target,kind)
	if(rc)
		return inv_say_result(id,rc)

	new me[33],they[33],item[33],desc[64],disposable,text[192]
	get_user_name(id,me,32)
	get_user_name(target,they,32)
	ARP_GetItemInfo(kind,item,32,desc,63,disposable)

	new upme[33],upitem[33]
	copy(upme,32,me)
	copy(upitem,32,item)
	strtoupper(upme)
	strtoupper(upitem)

	if(desc[0])
		formatex(text,191,"%s SHOWS YOU^n%s^n%s",upme,upitem,desc)
	else
		formatex(text,191,"%s SHOWS YOU^n%s",upme,upitem)

	h9vgui_notice(target,"show",H9V_NOTICE_BANNER,text,6.0,0.5,182,145,234,-1.0,0.45)

	formatex(text,191,"You show %s your %s.",they,item)
	inv_note(id,0,text)

	return 0
}

// INFO on a kind: its description, or "No description."
stock inv_op_info(id,kind)
{
	if(kind < 1 || kind > INV_MAX_KINDS || !ARP_ValidItemId(kind))
		return inv_deny(id,"There is no such item.")

	new name[33],desc[64],disposable
	ARP_GetItemInfo(kind,name,32,desc,63,disposable)

	inv_send_desc(id,kind,desc[0] ? desc : "No description.")

	return 0
}

// ---------------------------------------------------------------------------------------------------------------------- the exchange of goods
//
// Two players, each with an offer of up to 12 entries (a cell and a count of it) and an amount of money from the wallet. An exchange starts when one presses the
// use key on the other (the event Player_Use), who accepts (the use key on the first, or h9inv x accept). While it is open the cells that are offered are reserved:
// nothing can be used, dropped, given, moved or merged. ANY change by either side breaks BOTH seals and the seal button is dead for three seconds. When both have
// sealed, everything is checked again at that instant and the swap is made at once or not at all.

// whether an exchange is open for the player (its reserve is then part of what the window is sent)
stock bool:inv_exchange_open(id)
	return id >= 1 && id <= MAX_PLAYERS && g_TrState[id] == TR_TRADING

// ---- the messages (H9Trade)

stock tr_begin(id)
	engfunc(EngFunc_MessageBegin,MSG_ONE,g_MsgTrade,Float:{0.0,0.0,0.0},id)

stock tr_name(id,out[],len)
{
	new raw[33]
	get_user_name(id,raw,32)
	inv_clean(raw,out,len)
}

// INVITE: byte op, byte seconds left, string name
stock tr_send_invite(id,secs,const name[])
{
	new clean[INV_NAME_LEN]
	inv_clean(name,clean,INV_NAME_LEN)

	tr_begin(id)
	write_byte(TR_OP_INVITE)
	write_byte(clamp(secs,0,255))
	write_string(clean)
	message_end()
}

// OPEN: byte op, string partner, long wallet, byte cells (12), byte flags (bit 0: the money is called credits)
stock tr_send_open(id,const partner[])
{
	new clean[INV_NAME_LEN]
	inv_clean(partner,clean,INV_NAME_LEN)

	tr_begin(id)
	write_byte(TR_OP_OPEN)
	write_string(clean)
	write_long(max(0,ARP_GetUserWallet(id)))
	write_byte(TR_CELLS)
	write_byte(get_pcvar_num(p_Credits) ? 1 : 0)
	message_end()
}

// OFFER: byte op, byte side (0 mine, 1 theirs), byte entry, short item, short count, string name (the item's, for side 1)
stock tr_send_offer(id,side,e,kind,n,const name[])
{
	tr_begin(id)
	write_byte(TR_OP_OFFER)
	write_byte(side)
	write_byte(e)
	write_short(kind)
	write_short(min(n,32767))
	write_string(name)
	message_end()
}

// MONEY: byte op, byte side, long amount
stock tr_send_money(id,side,amount)
{
	tr_begin(id)
	write_byte(TR_OP_MONEY)
	write_byte(side)
	write_long(max(0,amount))
	message_end()
}

// SEAL: byte op, byte mine, byte theirs, byte tenths of a second until his seal may be pressed (0: now)
stock tr_send_seal(id)
{
	new p = g_TrPartner[id],tenths,Float:left = g_LockUntil[id] - get_gametime()
	if(left > 0.0)
		tenths = clamp(floatround(left * 10.0,floatround_ceil),0,30)

	tr_begin(id)
	write_byte(TR_OP_SEAL)
	write_byte(g_Sealed[id] ? 1 : 0)
	write_byte(p && g_Sealed[p] ? 1 : 0)
	write_byte(tenths)
	message_end()
}

// CLOSE: byte op, byte reason, string summary (what each side receives, when it was completed: two lines with a bar between them)
stock tr_send_close(id,reason,const summary[])
{
	new clean[181]
	inv_clean(summary,clean,181)

	tr_begin(id)
	write_byte(TR_OP_CLOSE)
	write_byte(reason)
	write_string(clean)
	message_end()
}

// a game that has the windows is told; any other is not
stock tr_tell(id,reason,const summary[])
{
	if(id >= 1 && id <= MAX_PLAYERS && is_user_connected(id) && g_MsgTrade > 0 && h9vgui_protocol(id) >= H9VGUI_INV_PROTOCOL)
		tr_send_close(id,reason,summary)
}

// ---- the state

// a player is out of any exchange: no offer, nothing reserved
stock tr_clear(id)
{
	g_TrState[id] = TR_IDLE
	g_TrPartner[id] = 0
	g_TrUntil[id] = 0.0
	g_OfMoney[id] = 0
	g_Sealed[id] = 0
	g_LockUntil[id] = 0.0

	for(new e;e < TR_CELLS;e++)
	{
		g_OfCell[id][e] = -1
		g_OfN[id][e] = 0
		g_OfKind[id][e] = 0
	}

	for(new c;c < INV_MAX_CELLS;c++)
		g_Res[id][c] = 0

	inv_kick(id)
}

// the exchange is over for both: each is told his reason, and the same two wait a moment before they can start again. The summary is a's; b's own when
// there is one (the money is worded for the player who reads it)
stock tr_finish(a,b,ra,rb,const summary[],const summary_b[] = "")
{
	new Float:now = get_gametime()

	if(a)
	{
		tr_tell(a,ra,summary)
		g_CoolWith[a] = b
		g_CoolUntil[a] = now + TR_PAIR_WAIT
		tr_clear(a)
	}

	if(b)
	{
		if(summary_b[0])
			tr_tell(b,rb,summary_b)
		else
			tr_tell(b,rb,summary)

		g_CoolWith[b] = a
		g_CoolUntil[b] = now + TR_PAIR_WAIT
		tr_clear(b)
	}
}

// the reserve of a player's cells follows his offer
stock tr_sync_res(id)
{
	for(new c;c < INV_MAX_CELLS;c++)
		g_Res[id][c] = 0

	for(new e;e < TR_CELLS;e++)
		if(g_OfCell[id][e] >= 0)
			g_Res[id][g_OfCell[id][e]] = g_OfN[id][e]

	inv_kick(id)
}

// whether the player is cuffed or in jail (ARP_JailMod answers, as its HUD decides it); no JailMod, no one
stock tr_restrained(id)
{
	if(callfunc_begin("H9_Restrained","ARP_JailMod.amxx") != 1)
		return 0

	callfunc_push_int(id)

	return callfunc_end()
}

// what an offer holds, as a line the viewer reads (0: a log): "Soda x5, Pizza x2, 150 credits" (nothing: "nothing"); cut to len with "..." when it is too long
stock tr_text(id,out[],len,viewer = 0)
{
	out[0] = 0
	new used,name[INV_NAME_LEN],bool:cut

	for(new e;e < TR_CELLS && !cut;e++)
	{
		if(g_OfCell[id][e] < 0)
			continue

		inv_item_name(g_OfKind[id][e],name,INV_NAME_LEN)

		new piece[64]
		formatex(piece,63,"%s%s x%d",used ? ", " : "",name,g_OfN[id][e])

		if(used + strlen(piece) > len - 5)
		{
			cut = true
			break
		}

		used += copy(out[used],len - 1 - used,piece)
	}

	if(g_OfMoney[id] > 0 && !cut)
	{
		new money[48],piece[64]
		inv_money(viewer,g_OfMoney[id],money,47,true)
		formatex(piece,63,"%s%s",used ? ", " : "",money)

		if(used + strlen(piece) > len - 5)
			cut = true
		else
			used += copy(out[used],len - 1 - used,piece)
	}

	if(cut)
		add(out,len - 1,"...")
	else if(!used)
		copy(out,len - 1,"nothing")
}

// ---- starting, answering, ending

// the use key was pressed on a player (Player_Use): the first press offers an exchange, and the invited player's press accepts it
stock tr_use(id,target)
{
	if(id < 1 || id > MAX_PLAYERS || target < 1 || target > MAX_PLAYERS || id == target || !g_On[id] || !is_user_alive(id) || !is_user_connected(target))
		return

	// a handcuffed player is searched, not offered an exchange
	if(sr_use(id,target))
		return

	new Float:now = get_gametime()
	tr_expire(id)

	if(g_TrState[id] == TR_INVITED && g_TrPartner[id] == target)
	{
		tr_accept(id)

		return
	}

	// a player in the middle of a search offers no exchange
	if(g_SrTarget[id])
	{
		inv_note(id,1,"Finish your search first.")

		return
	}

	if(g_TrState[id] != TR_IDLE || !inv_window(id))
		return

	// one invitation in three seconds
	if(now - g_InviteAt[id] < TR_INVITE_GAP && now >= g_InviteAt[id])
		return

	g_InviteAt[id] = now

	if(is_user_bot(target) || !is_user_alive(target))
	{
		inv_note(id,1,"That player cannot make an exchange.")

		return
	}

	if(!g_On[target])
	{
		inv_note(id,1,"That player is not ready.")

		return
	}

	if(tr_restrained(id))
	{
		inv_note(id,1,"You cannot make an exchange now.")

		return
	}

	if(tr_restrained(target))
	{
		inv_note(id,1,"That player cannot make an exchange now.")

		return
	}

	if(!inv_window(target))
	{
		inv_note(id,1,"That player has no inventory window.")

		return
	}

	tr_expire(target)

	if(g_TrState[target] != TR_IDLE || g_SrTarget[target])
	{
		tr_tell(id,TR_BUSY,"")

		return
	}

	if(g_CoolWith[id] == target && now < g_CoolUntil[id])
	{
		inv_note(id,0,"Wait a moment.")

		return
	}

	g_TrState[id] = TR_INVITING
	g_TrPartner[id] = target
	g_TrUntil[id] = now + float(TR_INVITE_SECS)
	g_TrState[target] = TR_INVITED
	g_TrPartner[target] = id
	g_TrUntil[target] = now + float(TR_INVITE_SECS)

	new name[INV_NAME_LEN],text[96]
	tr_name(id,name,INV_NAME_LEN)
	tr_send_invite(target,TR_INVITE_SECS,name)

	tr_name(target,name,INV_NAME_LEN)
	formatex(text,95,"Exchange offered to %s.",name)
	inv_note(id,0,text)
}

// an invitation that has lapsed is over (both sides are told)
stock tr_expire(id)
{
	if((g_TrState[id] == TR_INVITING || g_TrState[id] == TR_INVITED) && get_gametime() >= g_TrUntil[id])
		tr_finish(id,g_TrPartner[id],TR_LAPSED,TR_LAPSED,"")
}

// the invited player accepts: the exchange opens for both
stock tr_accept(id)
{
	if(g_TrState[id] != TR_INVITED)
		return inv_deny(id,"Nobody has offered you an exchange.")

	new a = g_TrPartner[id]

	if(a < 1 || !is_user_connected(a) || g_TrState[a] != TR_INVITING || g_TrPartner[a] != id)
	{
		tr_finish(id,0,TR_LAPSED,0,"")

		return 1
	}

	if(get_gametime() >= g_TrUntil[id])
	{
		tr_finish(id,a,TR_LAPSED,TR_LAPSED,"")

		return 1
	}

	if(!is_user_alive(id) || !is_user_alive(a))
	{
		tr_finish(id,a,is_user_alive(id) ? TR_THEY_DIED : TR_YOU_DIED,is_user_alive(a) ? TR_THEY_DIED : TR_YOU_DIED,"")

		return 1
	}

	if(tr_restrained(id) || tr_restrained(a))
	{
		tr_finish(id,a,TR_RESTRAINED,TR_RESTRAINED,"")

		return 1
	}

	if(!inv_window(id) || !inv_window(a))
	{
		tr_finish(id,a,TR_YOU_WITHDREW,TR_THEY_WITHDREW,"")

		return 1
	}

	if(float(get_entity_distance(id,a)) > get_pcvar_float(p_TradeRange))
	{
		tr_finish(id,a,TR_RANGE,TR_RANGE,"")

		return 1
	}

	new Float:now = get_gametime(),name[INV_NAME_LEN]

	tr_clear(a)
	tr_clear(id)

	g_TrState[a] = TR_TRADING
	g_TrPartner[a] = id
	g_TrChanged[a] = now
	g_TrState[id] = TR_TRADING
	g_TrPartner[id] = a
	g_TrChanged[id] = now

	tr_name(id,name,INV_NAME_LEN)
	tr_send_open(a,name)
	tr_name(a,name,INV_NAME_LEN)
	tr_send_open(id,name)

	inv_kick(a)
	inv_kick(id)

	return 0
}

// the invited player says no, or either one withdraws
stock tr_decline(id)
{
	if(g_TrState[id] != TR_INVITED)
		return inv_deny(id,"Nobody has offered you an exchange.")

	tr_finish(id,g_TrPartner[id],TR_DECLINED,TR_DECLINED,"")

	return 0
}

stock tr_cancel(id)
{
	if(g_TrState[id] == TR_IDLE)
		return inv_deny(id,"You are not in an exchange.")

	tr_finish(id,g_TrPartner[id],TR_YOU_WITHDREW,TR_THEY_WITHDREW,"")

	return 0
}

// a player is gone (disconnected, or the map changes): his partner is told
stock tr_gone(id,reason_for_partner)
{
	new p = g_TrPartner[id]

	if(g_TrState[id] != TR_IDLE && p)
	{
		tr_tell(p,reason_for_partner,"")

		if(g_TrPartner[p] == id)
			tr_clear(p)
	}

	tr_clear(id)
}

// whether an exchange may go on: both here, alive, free, with the window, near and not idle too long. When not, it is closed with the reason and 0 is returned.
stock tr_check(a,b)
{
	new Float:now = get_gametime()

	if(!is_user_connected(b) || !is_user_connected(a))
	{
		tr_finish(a,b,TR_THEY_LEFT,TR_THEY_LEFT,"")

		return 0
	}

	if(!is_user_alive(a) || !is_user_alive(b))
	{
		tr_finish(a,b,is_user_alive(a) ? TR_THEY_DIED : TR_YOU_DIED,is_user_alive(b) ? TR_THEY_DIED : TR_YOU_DIED,"")

		return 0
	}

	if(tr_restrained(a) || tr_restrained(b))
	{
		tr_finish(a,b,TR_RESTRAINED,TR_RESTRAINED,"")

		return 0
	}

	if(!inv_window(a) || !inv_window(b))
	{
		tr_finish(a,b,inv_window(a) ? TR_THEY_WITHDREW : TR_YOU_WITHDREW,inv_window(b) ? TR_THEY_WITHDREW : TR_YOU_WITHDREW,"")

		return 0
	}

	if(float(get_entity_distance(a,b)) > get_pcvar_float(p_TradeRange))
	{
		tr_finish(a,b,TR_RANGE,TR_RANGE,"")

		return 0
	}

	if(now - g_TrChanged[a] >= get_pcvar_float(p_TradeTimeout) && now - g_TrChanged[b] >= get_pcvar_float(p_TradeTimeout))
	{
		tr_finish(a,b,TR_TIMED_OUT,TR_TIMED_OUT,"")

		return 0
	}

	return 1
}

// every quarter of a second: the invitations that lapsed; every second: the exchanges that are open are looked at
stock tr_tick(bool:second)
{
	for(new id = 1;id <= MAX_PLAYERS;id++)
	{
		switch(g_TrState[id])
		{
			case TR_INVITING, TR_INVITED :
				tr_expire(id)

			case TR_TRADING :
				if(second)
					tr_check(id,g_TrPartner[id])
		}
	}
}

// ---- the offers

// something in an offer changed: both seals break, both buttons are dead for three seconds, both players are told, the reserve follows
stock tr_changed(id)
{
	new p = g_TrPartner[id],Float:now = get_gametime()

	g_Sealed[id] = 0
	g_Sealed[p] = 0
	g_LockUntil[id] = now + TR_SEAL_LOCK
	g_LockUntil[p] = now + TR_SEAL_LOCK
	g_TrChanged[id] = now
	g_TrChanged[p] = now

	tr_sync_res(id)
}

// the state of an exchange for a command: whether the player is in an open one, and (when he is) whether it may go on
stock tr_open_check(id)
{
	if(g_TrState[id] != TR_TRADING)
		return inv_deny(id,"You are not in an exchange.")

	if(!tr_check(id,g_TrPartner[id]))
		return 1

	return 0
}

// put n of a cell in the offer (entry e, or 255 for the first free one); the same cell again adds to its entry
stock tr_op_offer(id,cell,n,idx)
{
	if(tr_open_check(id))
		return 1

	new p = g_TrPartner[id],shown = inv_cells(id)

	if(cell < 0 || cell >= shown || !g_CK[id][cell])
		return inv_deny(id,"That cell is empty.")

	if(n < 1)
		return inv_deny(id,"That is not a count.")

	new e = -1
	for(new i;i < TR_CELLS;i++)
		if(g_OfCell[id][i] == cell)
			e = i

	if(e >= 0)
	{
		if(idx != 255 && idx != e)
			return inv_deny(id,"That cell is already in your offer.")

		if(g_OfN[id][e] + n > g_CN[id][cell])
			return inv_deny(id,"You do not have that many.")

		g_OfN[id][e] += n
	}
	else
	{
		if(n > g_CN[id][cell])
			return inv_deny(id,"You do not have that many.")

		if(idx != 255)
		{
			if(idx < 0 || idx >= TR_CELLS)
				return inv_deny(id,"That is not a place in the offer.")

			if(g_OfCell[id][idx] >= 0)
				return inv_deny(id,"That place is taken.")

			e = idx
		}
		else
		{
			for(new i;i < TR_CELLS && e < 0;i++)
				if(g_OfCell[id][i] < 0)
					e = i

			if(e < 0)
				return inv_deny(id,"Your offer is full.")
		}

		g_OfCell[id][e] = cell
		g_OfN[id][e] = n
		g_OfKind[id][e] = g_CK[id][cell]
	}

	tr_changed(id)

	new name[INV_NAME_LEN]
	inv_item_name(g_OfKind[id][e],name,INV_NAME_LEN)
	tr_send_offer(id,0,e,g_OfKind[id][e],g_OfN[id][e],"")
	tr_send_offer(p,1,e,g_OfKind[id][e],g_OfN[id][e],name)
	tr_send_seal(id)
	tr_send_seal(p)

	return 0
}

// take an entry back
stock tr_op_take(id,e)
{
	if(tr_open_check(id))
		return 1

	if(e < 0 || e >= TR_CELLS || g_OfCell[id][e] < 0)
		return inv_deny(id,"That place is empty.")

	new p = g_TrPartner[id]

	g_OfCell[id][e] = -1
	g_OfN[id][e] = 0
	g_OfKind[id][e] = 0

	tr_changed(id)

	tr_send_offer(id,0,e,0,0,"")
	tr_send_offer(p,1,e,0,0,"")
	tr_send_seal(id)
	tr_send_seal(p)

	return 0
}

// the money of the offer: 0 to the wallet (never the bank); it replaces the amount before
stock tr_op_money(id,amount)
{
	if(tr_open_check(id))
		return 1

	if(amount < 0 || amount > ARP_GetUserWallet(id))
		return inv_deny(id,"You do not have that much.")

	new p = g_TrPartner[id]

	g_OfMoney[id] = amount

	tr_changed(id)

	tr_send_money(id,0,amount)
	tr_send_money(p,1,amount)
	tr_send_seal(id)
	tr_send_seal(p)

	return 0
}

// ---- the swap

// whether every offered cell of a player still holds what was offered of it, and his money is still there
stock tr_valid(id)
{
	for(new e;e < TR_CELLS;e++)
	{
		new cell = g_OfCell[id][e]
		if(cell < 0)
			continue

		if(cell >= INV_MAX_CELLS || g_CK[id][cell] != g_OfKind[id][e] || !g_OfKind[id][e] || g_CN[id][cell] < g_OfN[id][e])
			return 0
	}

	return g_OfMoney[id] <= ARP_GetUserWallet(id)
}

// works the swap out on copies of both players' cells: each side's offered items leave its cells, then the other side's arrive (partial stacks first, then empty
// cells). Returns in fail_a and fail_b how many items could not be taken in by that side. When both are 0 the copies are the cells after the swap.
stock tr_work(a,b,&fail_a,&fail_b)
{
	fail_a = 0
	fail_b = 0

	for(new c;c < INV_MAX_CELLS;c++)
	{
		g_SimK[0][c] = g_CK[a][c]
		g_SimN[0][c] = g_CN[a][c]
		g_SimK[1][c] = g_CK[b][c]
		g_SimN[1][c] = g_CN[b][c]
	}

	for(new e;e < TR_CELLS;e++)
	{
		if(g_OfCell[a][e] >= 0)
			inv_take(g_SimK[0],g_SimN[0],g_ZeroRes,g_OfKind[a][e],g_OfN[a][e],g_OfCell[a][e])

		if(g_OfCell[b][e] >= 0)
			inv_take(g_SimK[1],g_SimN[1],g_ZeroRes,g_OfKind[b][e],g_OfN[b][e],g_OfCell[b][e])
	}

	new unlimited = !inv_slots(),cap = inv_cap()

	// what a gives arrives with b, and the other way
	for(new e;e < TR_CELLS;e++)
	{
		if(g_OfCell[a][e] >= 0)
		{
			new kind = g_OfKind[a][e],n = g_OfN[a][e],placed = inv_place(g_SimK[1],g_SimN[1],g_ZeroRes,kind,n,cap)
			if(placed < n)
			{
				if(unlimited)
					inv_fat(g_SimK[1],g_SimN[1],kind,n - placed)
				else
					fail_b += n - placed
			}
		}

		if(g_OfCell[b][e] >= 0)
		{
			new kind = g_OfKind[b][e],n = g_OfN[b][e],placed = inv_place(g_SimK[0],g_SimN[0],g_ZeroRes,kind,n,cap)
			if(placed < n)
			{
				if(unlimited)
					inv_fat(g_SimK[0],g_SimN[0],kind,n - placed)
				else
					fail_a += n - placed
			}
		}
	}
}

// the entries of one side, as "Soda x5, Pizza x2" for the log
stock tr_list(id,out[],len)
{
	new tmp = g_OfMoney[id]
	g_OfMoney[id] = 0
	tr_text(id,out,len)
	g_OfMoney[id] = tmp
}

stock tr_log(a,b,const what[])
{
	new na[33],nb[33],ia[36],ib[36],la[200],lb[200],ma[48],mb[48],map[33]
	get_user_name(a,na,32)
	get_user_name(b,nb,32)
	get_user_authid(a,ia,35)
	get_user_authid(b,ib,35)
	get_mapname(map,32)
	tr_list(a,la,199)
	tr_list(b,lb,199)
	inv_money(0,g_OfMoney[a],ma,47)
	inv_money(0,g_OfMoney[b],mb,47)

	log_amx("[ARP] exchange %s on %s: %s<%s> gave [%s] and %s, %s<%s> gave [%s] and %s",what,map,na,ia,la,ma,nb,ib,lb,mb)
	ARP_Log("Exchange %s on %s: ^"%s<%s>^" gave [%s] and %s, ^"%s<%s>^" gave [%s] and %s",what,map,na,ia,la,ma,nb,ib,lb,mb)
}

// both have sealed: everything is looked at again and the swap is made at once or not at all
stock tr_execute(a,b)
{
	// 1. both are still here, alive, free, near, and in this exchange with each other
	if(g_TrState[a] != TR_TRADING || g_TrPartner[a] != b || g_TrState[b] != TR_TRADING || g_TrPartner[b] != a)
		return

	if(!tr_check(a,b))
		return

	// 2. every offered cell still holds what was offered of it, and the money is still in the wallets
	new wa = ARP_GetUserWallet(a),wb = ARP_GetUserWallet(b)
	if(!tr_valid(a) || !tr_valid(b) || wa - g_OfMoney[a] + g_OfMoney[b] < 0 || wb - g_OfMoney[b] + g_OfMoney[a] < 0 || wa - g_OfMoney[a] > 2000000000 - g_OfMoney[b] || wb - g_OfMoney[b] > 2000000000 - g_OfMoney[a])
	{
		tr_log(a,b,"refused (an item or the money changed)")
		tr_finish(a,b,TR_CHECK_FAILED,TR_CHECK_FAILED,"")

		return
	}

	// 3. the fit, worked out on copies: nothing has moved yet
	new fail_a,fail_b
	tr_work(a,b,fail_a,fail_b)

	if(fail_a || fail_b)
	{
		tr_log(a,b,"refused (an inventory is full)")

		if(fail_a)
			tr_finish(a,b,TR_YOUR_FULL,TR_THEIR_FULL,"")
		else
			tr_finish(a,b,TR_THEIR_FULL,TR_YOUR_FULL,"")

		return
	}

	// 4. the swap: nothing from here on can fail. The copies become the cells, the counts follow the cells, the money moves, both are saved.
	new la[47],lb[47],na[33],nb[33]
	get_user_name(a,na,32)
	get_user_name(b,nb,32)
	strtoupper(na)
	strtoupper(nb)

	new kinds[TR_CELLS * 2],nk
	for(new e;e < TR_CELLS;e++)
	{
		if(g_OfCell[a][e] >= 0)
			kinds[nk++] = g_OfKind[a][e]

		if(g_OfCell[b][e] >= 0)
			kinds[nk++] = g_OfKind[b][e]
	}

	new moneyA = g_OfMoney[a],moneyB = g_OfMoney[b]
	tr_log(a,b,"completed")

	for(new c;c < INV_MAX_CELLS;c++)
	{
		g_CK[a][c] = g_SimK[0][c]
		g_CN[a][c] = g_SimN[0][c]
		g_CK[b][c] = g_SimK[1][c]
		g_CN[b][c] = g_SimN[1][c]
	}

	g_Self[a]++
	g_Self[b]++

	for(new i;i < nk;i++)
	{
		ARP_SetUserItemNum(a,kinds[i],inv_have(g_CK[a],g_CN[a],kinds[i]))
		ARP_SetUserItemNum(b,kinds[i],inv_have(g_CK[b],g_CN[b],kinds[i]))
	}

	g_Self[a]--
	g_Self[b]--

	ARP_SetUserWallet(a,wa - moneyA + moneyB)
	ARP_SetUserWallet(b,wb - moneyB + moneyA)

	inv_set_over(a)
	inv_set_over(b)

	ARP_SaveUser(a)
	ARP_SaveUser(b)

	// 5. the result lines: "<NAME> RECEIVES: ...|<NAME> RECEIVES: ...", the player with the lower number first, each read by the player it is sent to (his money is
	// worded for him: the credit sign where he is shown it)
	new summary_a[181],summary_b[181]
	tr_text(b,la,46,a)
	tr_text(a,lb,46,a)
	if(a < b)
		formatex(summary_a,180,"%s RECEIVES: %s|%s RECEIVES: %s",na,la,nb,lb)
	else
		formatex(summary_a,180,"%s RECEIVES: %s|%s RECEIVES: %s",nb,lb,na,la)

	tr_text(b,la,46,b)
	tr_text(a,lb,46,b)
	if(a < b)
		formatex(summary_b,180,"%s RECEIVES: %s|%s RECEIVES: %s",na,la,nb,lb)
	else
		formatex(summary_b,180,"%s RECEIVES: %s|%s RECEIVES: %s",nb,lb,na,la)

	tr_finish(a,b,TR_DONE,TR_DONE,summary_a,summary_b)

	inv_kick(a)
	inv_kick(b)
}

// the seal: refused while its button is dead, when nothing is offered by either side, and when the swap would not fit; both sealed makes the swap
stock tr_op_seal(id)
{
	if(tr_open_check(id))
		return 1

	new p = g_TrPartner[id],Float:now = get_gametime()

	if(now < g_LockUntil[id])
		return inv_deny(id,"The seal waits 3 seconds after a change.")

	new nothing = 1
	for(new e;e < TR_CELLS;e++)
		if(g_OfCell[id][e] >= 0 || g_OfCell[p][e] >= 0)
			nothing = 0

	if(nothing && !g_OfMoney[id] && !g_OfMoney[p])
		return inv_deny(id,"Nothing is offered.")

	if(!tr_valid(id) || !tr_valid(p))
		return inv_deny(id,"An item or the money changed.")

	new fail_a,fail_b
	tr_work(id,p,fail_a,fail_b)
	if(fail_a)
		return inv_deny(id,"Your inventory is full.")

	if(fail_b)
	{
		new name[33],text[96]
		get_user_name(p,name,32)
		formatex(text,95,"%s's inventory is full.",name)

		return inv_deny(id,text)
	}

	g_Sealed[id] = 1
	tr_send_seal(id)
	tr_send_seal(p)

	if(g_Sealed[p])
		tr_execute(id,p)

	return 0
}

stock tr_op_unseal(id)
{
	if(tr_open_check(id))
		return 1

	g_Sealed[id] = 0
	tr_send_seal(id)
	tr_send_seal(g_TrPartner[id])

	return 0
}

// h9inv x <sub> ...
stock tr_command(id,const sub[],const a2[],const a3[],const a4[])
{
	if(equal(sub,"accept"))
		return tr_accept(id)

	if(equal(sub,"decline"))
		return tr_decline(id)

	if(equal(sub,"cancel"))
		return tr_cancel(id)

	if(equal(sub,"seal"))
		return tr_op_seal(id)

	if(equal(sub,"unseal"))
		return tr_op_unseal(id)

	if(equal(sub,"offer"))
	{
		new c = inv_arg(a2),n = inv_arg(a3),e = a4[0] ? inv_arg(a4) : 255

		return (c < 0 || n < 0 || e < 0) ? inv_deny(id,"That is not a command.") : tr_op_offer(id,c,n,e)
	}

	if(equal(sub,"take"))
	{
		new e = inv_arg(a2)

		return e < 0 ? inv_deny(id,"That is not a command.") : tr_op_take(id,e)
	}

	if(equal(sub,"money"))
	{
		new m = inv_arg(a2)

		return m < 0 ? inv_deny(id,"That is not a command.") : tr_op_money(id,m)
	}

	return 1
}

// ---------------------------------------------------------------------------------------------------------------------- the arrangement in the database
//
// The counts a player owns are in arp_items and stay the truth. What this part keeps, in a table of its own, is WHERE he put them: one row for each character,
// the cells as text with the item NAMES ("<cell>:<count>:<name>|..."; item numbers are not stable across a restart). No row of any ARP table is changed: the
// table is made with CREATE TABLE IF NOT EXISTS the first time it is needed, and going back is dropping it. arp_h9_inv_persist 0 is the plugin as it was before:
// the cells are packed at every join and nothing is read or written.
//
//   SAVE   when the cells differ from what the database holds (a signature of them is compared), once they have been quiet for INV_DB_QUIET seconds or have been
//          changing for INV_DB_MAX; and whenever ARP_Core saves the character (its Player_Save event: now and then, at disconnect, at a map change).
//   LOAD   when the character has loaded (Player_Ready), after the cells have been packed as ever: the row is asked for and, when it comes, laid over the packed
//          cells as far as he still owns the items (InvDbApply). A missing, unreadable or late row, a database that is down, and any error leave the packed cells.

#define INV_DB_QUIET     3.0     // seconds the cells have to stay as they are before a changed arrangement is written
#define INV_DB_MAX       15.0    // the longest a changed arrangement waits for that
#define INV_DB_BACKOFF   60.0    // seconds nothing is tried again after the database failed
#define INV_DB_TEXT      3500    // the cells of a row, as text, are cut at this: ARP_CleverQuery holds 4095 characters of a query

// the character key the row is kept under: ARP's own (ARP_GetUserKey: his authid, or the key of his havoc9.org account); none for a bot, a player not here, and an authid ARP
// does not save a character under (pending, LAN, unknown: the key of an account is good whatever the authid says)
stock inv_db_key(id,key[],len)
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

// a number that says which cells hold what: equal cells, equal number
stock inv_db_sig(id)
{
	new h = 7

	for(new c;c < INV_MAX_CELLS;c++)
		if(g_CK[id][c] && g_CN[id][c] > 0)
			h = h * 31 + (c + 1) * 65599 + g_CK[id][c] * 977 + g_CN[id][c]

	return h ? h : 1
}

// a failed query: said once in a while in the log, and the database is left alone for a time
stock inv_db_fail(const what[],const why[])
{
	if(get_gametime() >= g_DbFailUntil)
		log_amx("[ARP] inventory: the database failed (%s: %s): the arrangement is not read or stored for now",what,why)

	g_DbFailUntil = get_gametime() + INV_DB_BACKOFF
}

// whether the table is there (made once, here, with a query that waits: it is a few milliseconds, and the queries after it can rely on it)
stock bool:inv_db_table()
{
	if(g_DbMade)
		return true

	new err,msg[128],Handle:db = SQL_Connect(ARP_SqlHandle(),err,msg,127)
	if(db == Empty_Handle || err)
	{
		inv_db_fail("connect",msg)

		return false
	}

	new query[300]
	if(ARP_SqlMode() == MYSQL)
		formatex(query,299,"CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),cells TEXT,updated INT(11),UNIQUE KEY (authid))",g_DbTable)
	else
		formatex(query,299,"CREATE TABLE IF NOT EXISTS %s (authid VARCHAR(36),cells TEXT,updated INT(11),UNIQUE (authid))",g_DbTable)

	new Handle:st = SQL_PrepareQuery(db,"%s",query),bool:ok = SQL_Execute(st) ? true : false
	if(!ok)
		SQL_QueryError(st,msg,127)

	SQL_FreeHandle(st)
	SQL_FreeHandle(db)

	if(!ok)
	{
		inv_db_fail("create",msg)

		return false
	}

	g_DbMade = 1

	return true
}

// whether the arrangement may be read and written now: the switch is on, the database is up, and nothing failed a moment ago
stock bool:inv_db_ready()
{
	if(!get_pcvar_num(p_Persist) || get_gametime() < g_DbFailUntil || ARP_SqlHandle() == Empty_Handle)
		return false

	return inv_db_table()
}

// the cells of a player as text: "<cell>:<count>:<name>|..." in cell order (an item whose name has a "|" in it is left out); the name is quoted for the query.
// Cut at INV_DB_TEXT characters, whole cells only.
stock inv_db_text(id,out[],len)
{
	out[0] = 0

	new used,raw[70],piece[96]

	for(new c;c < INV_MAX_CELLS;c++)
	{
		if(!g_CK[id][c] || g_CN[id][c] < 1 || !ARP_ValidItemId(g_CK[id][c]))
			continue

		ARP_GetItemName(g_CK[id][c],raw,32)

		if(!raw[0] || contain(raw,"|") != -1)
			continue

		ARP_SqlEscape(raw,69)
		formatex(piece,95,"%s%d:%d:%s",used ? "|" : "",c,g_CN[id][c],raw)

		if(used + strlen(piece) >= len - 1 || used + strlen(piece) > INV_DB_TEXT)
			break

		used += copy(out[used],len - 1 - used,piece)
	}

	return used
}

// writes the arrangement of a player when it is not what the database holds (force: whatever it holds); not when he has no cells
stock inv_db_save(id,bool:force = false)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id] || !g_DbKey[id][0] || !inv_db_ready())
		return

	new sig = inv_db_sig(id)
	if(!force && sig == g_DbSig[id])
		return

	static text[INV_DB_TEXT + 100],query[INV_DB_TEXT + 400]

	// an arrangement of no cells is not written over a row: a character whose counts did not load, or who really has nothing now, must not wipe where his items were
	// (a saved cell of an item he does not own is ignored when the row is read, so a row that is out of date is harmless)
	if(!inv_db_text(id,text,INV_DB_TEXT + 100))
	{
		g_DbSig[id] = sig

		return
	}

	new key[72]
	copy(key,71,g_DbKey[id])
	ARP_SqlEscape(key,71)

	if(ARP_SqlMode() == MYSQL)
		formatex(query,charsmax(query),"REPLACE INTO %s (authid,cells,updated) VALUES ('%s','%s',%d)",g_DbTable,key,text,get_systime())
	else
		formatex(query,charsmax(query),"INSERT OR REPLACE INTO %s (authid,cells,updated) VALUES ('%s','%s',%d)",g_DbTable,key,text,get_systime())

	new data[3]
	data[0] = id
	data[1] = get_user_userid(id)
	data[2] = sig

	g_DbSig[id] = sig
	g_DbSince[id] = 0.0
	g_DbWrites++

	ARP_CleverQuery(ARP_SqlHandle(),"InvDbSaved",query,data,3)
}

// the answer to a write: a failed one is tried again after the backoff (the signature is forgotten, so the arrangement counts as changed)
public InvDbSaved(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused query,size,queuetime

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		inv_db_fail("write",error)

		new id = data[0]
		if(id >= 1 && id <= MAX_PLAYERS && g_DbSig[id] == data[2])
			g_DbSig[id] = 0
	}

	return PLUGIN_CONTINUE
}

// once a second: the arrangements that changed are written when they have been quiet, or have been changing for a long time
stock inv_db_pass(const players[],num)
{
	if(!get_pcvar_num(p_Persist))
		return

	new Float:now = get_gametime()

	for(new i;i < num;i++)
	{
		new id = players[i]
		if(!g_On[id] || !g_DbKey[id][0])
			continue

		new sig = inv_db_sig(id)
		if(sig == g_DbSig[id])
		{
			g_DbSince[id] = 0.0

			continue
		}

		if(g_DbSince[id] == 0.0)
		{
			g_DbSince[id] = now
			g_DbLast[id] = now
			g_DbSeen[id] = sig

			continue
		}

		if(sig != g_DbSeen[id])
		{
			g_DbSeen[id] = sig
			g_DbLast[id] = now

			continue
		}

		if(now - g_DbLast[id] >= INV_DB_QUIET || now - g_DbSince[id] >= INV_DB_MAX)
			inv_db_save(id)
	}
}

// ARP_Core saves the character (every arp_save_interval seconds, at disconnect, at a map change): the arrangement is written with it when it changed
public EventPlayerSave(Name[],Data[],Len)
{
	inv_db_save(Data[0])

	return PLUGIN_CONTINUE
}

// the character has loaded and the cells are packed: his saved arrangement is asked for
stock inv_db_load(id)
{
	g_DbKey[id][0] = 0
	g_DbSig[id] = 0
	g_DbSince[id] = 0.0
	g_DbPending[id] = 0
	g_DbSeq[id]++

	if(!get_pcvar_num(p_Persist))
		return

	inv_db_key(id,g_DbKey[id],35)
	if(!g_DbKey[id][0])
		return

	// until the row says otherwise the database is taken to hold what a join makes: nothing is written for a layout nobody changed
	g_DbJoinSig[id] = inv_db_sig(id)
	g_DbSig[id] = g_DbJoinSig[id]

	if(!inv_db_ready())
		return

	new key[72],query[260]
	copy(key,71,g_DbKey[id])
	ARP_SqlEscape(key,71)
	formatex(query,259,"SELECT cells FROM %s WHERE authid='%s'",g_DbTable,key)

	new data[3]
	data[0] = id
	data[1] = get_user_userid(id)
	data[2] = g_DbSeq[id]

	g_DbPending[id] = 1
	g_DbReads++

	ARP_CleverQuery(ARP_SqlHandle(),"InvDbLoaded",query,data,3)
}

// the answer to a read: the row is laid over the packed cells, unless the player is gone, or has been arranging his cells in the meantime
public InvDbLoaded(failstate,Handle:query,error[],errnum,data[],size,Float:queuetime)
{
	#pragma unused size,queuetime

	new id = data[0]

	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || get_user_userid(id) != data[1] || g_DbSeq[id] != data[2] || !g_DbPending[id] || !g_On[id])
		return PLUGIN_CONTINUE

	g_DbPending[id] = 0

	if(failstate != TQUERY_SUCCESS || errnum)
	{
		inv_db_fail("read",error)

		return PLUGIN_CONTINUE
	}

	if(SQL_NumResults(query) < 1)
		return PLUGIN_CONTINUE

	static text[INV_DB_TEXT + 100]
	text[0] = 0
	SQL_ReadResult(query,0,text,INV_DB_TEXT + 99)

	// his cells are no longer what a join made: what he did since wins, and is written in its turn
	if(inv_db_sig(id) != g_DbJoinSig[id] || g_TrState[id] != TR_IDLE)
	{
		g_DbSig[id] = 0

		return PLUGIN_CONTINUE
	}

	inv_db_apply(id,text)

	return PLUGIN_CONTINUE
}

// the saved arrangement over what he owns now. Each saved cell is put back where it was, with the count it held clipped to what he still has and to the stack limit;
// an item that does not exist any more, or that he no longer has, is dropped; a cell beyond a lowered limit of cells is pulled into an empty cell inside it (in the
// order they were saved); and whatever he owns that no saved cell took is added the way a purchase is (partial stacks of its kind, then empty cells, kinds in item
// order) and, when the cells inside the limit are full, beyond it, as a join does: nothing he owns is left out of the cells. The counts are never changed.
stock inv_db_apply(id,const text[])
{
	new cell[INV_MAX_CELLS],kind[INV_MAX_CELLS],cnt[INV_MAX_CELLS],np,len = strlen(text)

	for(new i;i < len && np < INV_MAX_CELLS;)
	{
		new e = i
		while(e < len && text[e] != '|')
			e++

		new p = i,c,digits,n
		while(p < e && text[p] >= '0' && text[p] <= '9' && digits < 4)
		{
			c = c * 10 + text[p] - '0'
			p++
			digits++
		}

		if(digits && p < e && text[p] == ':')
		{
			p++
			digits = 0

			while(p < e && text[p] >= '0' && text[p] <= '9' && digits < 6)
			{
				n = n * 10 + text[p] - '0'
				p++
				digits++
			}

			if(digits && p < e && text[p] == ':' && p + 1 < e)
			{
				new name[INV_NAME_LEN]
				copy(name,INV_NAME_LEN - 1,text[p + 1])
				name[min(e - p - 1,INV_NAME_LEN - 1)] = 0

				new k = inv_find_kind(name)
				if(k && c >= 0 && c < INV_MAX_CELLS && n > 0)
				{
					cell[np] = c
					kind[np] = k
					cnt[np] = n
					np++
				}
			}
		}

		i = e + 1
	}

	new owned[INV_MAX_KINDS + 1]
	for(new k = 1;k <= INV_MAX_KINDS && ARP_ValidItemId(k);k++)
		owned[k] = ARP_GetUserItemNum(id,k)

	new nk[INV_MAX_CELLS],nn[INV_MAX_CELLS],cap = inv_cap(),bool:adapted
	new dk[INV_MAX_CELLS],dn[INV_MAX_CELLS],nd

	for(new i;i < np;i++)
	{
		new k = kind[i],put = min(min(cnt[i],owned[k]),inv_stackmax(k))
		if(put < 1)
		{
			adapted = true

			continue
		}

		if(put < cnt[i])
			adapted = true

		if(cell[i] >= cap || nk[cell[i]])
		{
			dk[nd] = k
			dn[nd] = put
			nd++
			adapted = true

			continue
		}

		nk[cell[i]] = k
		nn[cell[i]] = put
		owned[k] -= put
	}

	for(new i;i < nd;i++)
	{
		new k = dk[i],put = min(dn[i],owned[k]),t = inv_first_empty(nk,cap)
		if(put < 1 || t < 0)
			continue

		nk[t] = k
		nn[t] = put
		owned[k] -= put
	}

	for(new c;c < INV_MAX_CELLS;c++)
	{
		g_CK[id][c] = nk[c]
		g_CN[id][c] = nn[c]
		g_Res[id][c] = 0
	}

	g_Lost[id] = 0

	for(new k = 1;k <= INV_MAX_KINDS && ARP_ValidItemId(k);k++)
	{
		if(owned[k] < 1)
			continue

		adapted = true

		new placed = inv_place(g_CK[id],g_CN[id],g_Res[id],k,owned[k],INV_MAX_CELLS)
		if(placed < owned[k])
			g_Lost[id] += owned[k] - placed - inv_fat(g_CK[id],g_CN[id],k,owned[k] - placed)
	}

	inv_set_over(id)
	inv_kick(id)

	// what the database holds is what was laid over the cells, unless they had to be adapted: then the adapted ones are written when it is quiet
	g_DbSig[id] = adapted ? 0 : inv_db_sig(id)
	g_DbApplied++
}

// ---------------------------------------------------------------------------------------------------------------------- the search of a handcuffed player
//
// A player who presses the use key on a handcuffed (or jailed) player, as ARP_JailMod says it (H9_Restrained), is not offered an exchange: a window opens on his screen with the
// other player's cells beside his own, and what he takes with it goes from the one's inventory to the other's at once. The messages are H9Search (op 1 OPEN, 2 SLOTS, 3 CLOSE,
// 4 NOTE); the commands are "h9inv s take <cell> <n>" and "h9inv s close". arp_h9_search switches it (0: the use key on a handcuffed player does what it did: "That player cannot
// make an exchange now."). docs\ARP_INVENTORY.txt, section 9, has the rules and the layouts.

// the searcher's game draws the search window, and the feature is on
stock bool:sr_window(id)
	return get_pcvar_num(p_Search) && inv_window(id) && g_MsgSearch > 0 && h9vgui_protocol(id) >= H9VGUI_SEARCH_PROTOCOL ? true : false

stock sr_begin(id)
	engfunc(EngFunc_MessageBegin,MSG_ONE,g_MsgSearch,Float:{0.0,0.0,0.0},id)

// OPEN: byte op, byte flags (bit 0 over capacity), short cells, string name
stock sr_send_open(s,t)
{
	new raw[33],name[INV_NAME_LEN]
	get_user_name(t,raw,32)
	inv_clean(raw,name,INV_NAME_LEN)

	sr_begin(s)
	write_byte(SR_OP_OPEN)
	write_byte(inv_flags(t) & 1)
	write_short(inv_shown(t))
	write_string(name)
	message_end()
}

// SLOTS: byte op, short first, byte count, then count of { short kind, short n } (his cells); remembers what the searcher's game was told
stock sr_send_slots(s,t,first,count)
{
	sr_begin(s)
	write_byte(SR_OP_SLOTS)
	write_short(first)
	write_byte(count)

	for(new c = first;c < first + count;c++)
	{
		write_short(g_CK[t][c])
		write_short(min(g_CN[t][c],32767))

		g_SrSK[s][c] = g_CK[t][c]
		g_SrSN[s][c] = g_CN[t][c]
	}

	message_end()
}

stock sr_send_close(s,reason)
{
	if(s < 1 || s > MAX_PLAYERS || !is_user_connected(s) || g_MsgSearch <= 0 || h9vgui_protocol(s) < H9VGUI_SEARCH_PROTOCOL)
		return

	sr_begin(s)
	write_byte(SR_OP_CLOSE)
	write_byte(reason)
	message_end()
}

// NOTE: byte op, byte level, string text: one line for the search window's status row
stock sr_note(s,level,const text[])
{
	if(s < 1 || s > MAX_PLAYERS || !g_SrTarget[s] || !is_user_connected(s) || !sr_window(s))
		return

	new clean[121]
	inv_clean(text,clean,121)

	sr_begin(s)
	write_byte(SR_OP_NOTE)
	write_byte(level)
	write_string(clean)
	message_end()
}

// a refusal in the search window: the line, level 1; returns 1 for the caller to return
stock sr_deny(s,const text[])
{
	sr_note(s,1,text)

	return 1
}

// the searcher's game reads the money op, and the switch is on
stock bool:sr_money_window(s)
	return get_pcvar_num(p_SearchMoney) && sr_window(s) && h9vgui_protocol(s) >= H9VGUI_SEARCHMONEY_PROTOCOL ? true : false

// MONEY: byte op, long wallet: what the player searched has in his wallet (never the bank), so that the window can offer to take some of it
stock sr_send_money(s,wallet)
{
	sr_begin(s)
	write_byte(SR_OP_MONEY)
	write_long(wallet)
	message_end()

	g_SrMoney[s] = wallet
}

// the searcher's game is told what the other's wallet holds: after the snapshot, and again whenever it changes
stock sr_money_sync(s)
{
	new t = g_SrTarget[s]
	if(!t || g_SrPending[s] || !sr_money_window(s))
		return

	new wallet = max(ARP_GetUserWallet(t),0)
	if(wallet == g_SrMoney[s])
		return

	if(!inv_budget(s))
	{
		inv_kick(s)

		return
	}

	sr_send_money(s,wallet)
}

// the header and the cells of the player searched, to the searcher: the whole snapshot after an OPEN, then only the cells that changed. Called when his own window is flushed, so that
// his own cells have gone first (and again when his own window has nothing more to send).
stock sr_flush(s)
{
	new t = g_SrTarget[s]
	if(!t || !sr_window(s))
		return

	new shown = inv_shown(t),flags = inv_flags(t) & 1,bool:more,bool:fresh

	if(g_SrPending[s] || shown != g_SrShown[s] || flags != g_SrFlags[s])
	{
		if(!inv_budget(s))
		{
			inv_kick(s)

			return
		}

		sr_send_open(s,t)

		fresh = true
		g_SrPending[s] = 0
		g_SrShown[s] = shown
		g_SrFlags[s] = flags
		g_SrMoney[s] = -1

		for(new c;c < INV_MAX_CELLS;c++)
		{
			g_SrSK[s][c] = -1
			g_SrSN[s][c] = 0
		}
	}

	new c
	while(c < shown)
	{
		if(g_CK[t][c] == g_SrSK[s][c] && g_CN[t][c] == g_SrSN[s][c])
		{
			c++

			continue
		}

		new first = c,count
		while(c < shown && count < INV_SLOTS_CHUNK && (g_CK[t][c] != g_SrSK[s][c] || g_CN[t][c] != g_SrSN[s][c]))
		{
			count++
			c++
		}

		// the kinds of this run that his game does not know yet (the catalog is the one his own cells use)
		new need[INV_SLOTS_CHUNK],needs
		for(new k = first;k < first + count;k++)
		{
			new kind = g_CK[t][k]
			if(kind < 1 || kind > INV_MAX_KINDS || g_CatSent[s][kind])
				continue

			new known
			for(new j;j < needs;j++)
				if(need[j] == kind)
					known = 1

			if(!known)
				need[needs++] = kind
		}

		if(needs && inv_send_catalog(s,need,needs) < needs)
		{
			more = true

			break
		}

		if(!inv_budget(s))
		{
			more = true

			break
		}

		sr_send_slots(s,t,first,count)
	}

	// a player with nothing on him: the window opens all the same, and says so
	if(fresh && !more && !inv_used(g_CK[t]))
		sr_note(s,0,"He has nothing on him.")

	if(!more)
		sr_money_sync(s)

	if(more)
		inv_kick(s)
}

// the search ends: nothing is searched any more; the searcher's game is told why (a negative reason: it is not, his window is the one that closed)
stock sr_end(s,reason)
{
	new t = g_SrTarget[s]
	if(!t)
		return

	g_SrTarget[s] = 0
	g_SrPending[s] = 0
	g_SrMoney[s] = -1

	if(g_SrBy[t] == s)
		g_SrBy[t] = 0

	if(reason >= 0)
		sr_send_close(s,reason)
}

// the first thing that stops a search, as the reason to close it with; -1 when it may go on
stock sr_check(s,t)
{
	if(!get_pcvar_num(p_Search))
		return SR_OFF

	if(!is_user_connected(s) || !is_user_alive(s) || !g_On[s] || !inv_window(s) || tr_restrained(s))
		return SR_GONE

	if(!is_user_connected(t) || !g_On[t])
		return SR_LEFT

	if(!is_user_alive(t))
		return SR_DIED

	if(!tr_restrained(t))
		return SR_FREED

	if(float(get_entity_distance(s,t)) > get_pcvar_float(p_SearchRange))
		return SR_FAR

	return -1
}

// the search a player has open is closed when it may not go on
stock sr_settle(s)
{
	new t = g_SrTarget[s]
	if(!t)
		return

	new why = sr_check(s,t)
	if(why >= 0)
	{
		sr_end(s,why)

		return
	}

	sr_money_sync(s)
}

// every second: the searches that may not go on are closed, and a wallet that changed is told
stock sr_tick()
{
	for(new s = 1;s <= MAX_PLAYERS;s++)
		sr_settle(s)
}

// a player died: the search he was in ends, and the other is told
stock sr_died(id)
{
	if(g_SrTarget[id])
		sr_end(id,SR_GONE)

	if(g_SrBy[id])
		sr_end(g_SrBy[id],SR_DIED)
}

// a player left the game: the search he was in ends, and the other is told (he himself is not: he is going)
stock sr_left(id)
{
	if(g_SrTarget[id])
		sr_end(id,-1)

	if(g_SrBy[id])
		sr_end(g_SrBy[id],SR_LEFT)
}

// a player's cells are made again, or he joins or leaves: whatever he was in is over, and the other is told that he is gone
stock sr_reset(id)
{
	if(g_SrTarget[id])
		sr_end(id,-1)

	if(g_SrBy[id])
		sr_end(g_SrBy[id],SR_LEFT)

	g_SrShown[id] = 0
	g_SrFlags[id] = 0
	g_SrMoney[id] = -1
}

// the use key was pressed on a player (Player_Use): 1 when it was the search's, so that the exchange rules do not run
stock sr_use(id,target)
{
	if(!get_pcvar_num(p_Search) || id < 1 || id > MAX_PLAYERS || target < 1 || target > MAX_PLAYERS || id == target || !is_user_connected(id) || !is_user_connected(target))
		return 0

	// a free player is invited, as ever; a game that cannot draw the window gets today's refusal from the exchange rules
	if(!tr_restrained(target) || !sr_window(id))
		return 0

	// from here the press is the search's
	if(is_user_bot(target))
		return 1

	// a search that may not go on is over now, not at the next tick: the target may be a searcher whose cuffs went on a moment ago, and the searcher the target of one
	sr_settle(target)

	if(g_SrBy[id])
		sr_settle(g_SrBy[id])

	if(!is_user_alive(id) || tr_restrained(id) || g_SrBy[id])
	{
		inv_note(id,1,"You cannot do that now.")

		return 1
	}

	if(!is_user_alive(target))
		return 1

	if(!g_On[target])
	{
		inv_note(id,1,"That player is not ready.")

		return 1
	}

	if(g_SrTarget[id] == target)
		return 1

	// an exchange he had open when the cuffs went on is over now (the tick would close it within a second): none of his cells is held when he is searched
	if(g_TrState[target] == TR_TRADING)
		tr_check(target,g_TrPartner[target])

	tr_expire(id)

	if(g_TrState[id] != TR_IDLE)
	{
		inv_note(id,1,"Finish your exchange first.")

		return 1
	}

	if(g_SrBy[target] && g_SrBy[target] != id)
	{
		inv_note(id,1,"Somebody is already searching him.")

		return 1
	}

	new Data[2]
	Data[0] = id
	Data[1] = target

	if(ARP_CallEvent("Player_Search",Data,2))
		return 1

	// a search that is open on somebody else is replaced
	if(g_SrTarget[id])
		sr_end(id,-1)

	g_SrTarget[id] = target
	g_SrBy[target] = id
	g_SrPending[id] = 1

	new name[33]
	get_user_name(id,name,32)
	client_print(target,print_chat,"[ARP] %s is searching you.",name)

	// his own window first (it is opened for him if it is not open), then the other's cells
	if(g_Open[id])
		inv_flush(id)
	else
		inv_open(id)

	return 1
}

// h9inv s take <cell> <n>: n of a cell of his grid go to the searcher, as many as his inventory has room for; ONE function with no wait and no event: the count goes down
// for the one and up for the other through the core's own count change
stock sr_take(s,cell,n)
{
	new t = g_SrTarget[s]
	if(!t)
		return inv_deny(s,"You are not searching anyone.")

	new why = sr_check(s,t)
	if(why >= 0)
	{
		sr_end(s,why)

		return 1
	}

	if(cell < 0 || cell >= inv_shown(t) || !g_CK[t][cell])
		return sr_deny(s,"That cell is empty.")

	if(n < 1)
		return sr_deny(s,"That is not a number.")

	if(n > g_CN[t][cell])
		return sr_deny(s,"He does not have that many.")

	new kind = g_CK[t][cell],take = n
	if(inv_slots())
		take = min(take,inv_room(g_CK[s],g_CN[s],g_Res[s],kind,inv_cap()))

	// the cells and the counts agree (the plugin's invariant), so this changes nothing: a take never goes below none for him whatever happens
	take = min(take,ARP_GetUserItemNum(t,kind))

	if(take < 1)
		return sr_deny(s,"Your inventory is full.")

	new item[33],sname[33],tname[33],sauth[36],tauth[36],map[33]
	ARP_GetItemName(kind,item,32)
	get_user_name(s,sname,32)
	get_user_name(t,tname,32)
	get_user_authid(s,sauth,35)
	get_user_authid(t,tauth,35)
	get_mapname(map,32)

	new have_t = ARP_GetUserItemNum(t,kind),have_s = ARP_GetUserItemNum(s,kind)

	g_ActKind[t] = kind
	g_ActCell[t] = cell
	ARP_SetUserItemNum(t,kind,have_t - take)
	g_ActKind[t] = 0
	g_ActCell[t] = -1

	ARP_SetUserItemNum(s,kind,have_s + take)

	log_amx("[ARP] search on %s: %s<%s> took %d %s from %s<%s>",map,sname,sauth,take,item,tname,tauth)
	ARP_Log("Search on %s: ^"%s<%s>^" took %d ^"%s^" from ^"%s<%s>^"",map,sname,sauth,take,item,tname,tauth)

	client_print(t,print_chat,"[ARP] %s took %d %s from you.",sname,take,item)

	new text[121]
	if(take < n)
		formatex(text,120,"You took %d of %d %s. Your inventory is full.",take,n,item)
	else
		formatex(text,120,"You took %d %s.",take,item)

	sr_note(s,0,text)

	inv_kick(s)
	inv_kick(t)

	return 0
}

// h9inv s money <n>: n of his wallet go to the searcher's wallet, or all of it when he holds less (the amount the searcher saw may be old); the bank is never touched,
// and nothing is made or lost. One function with no wait and no event, like the take of a cell
stock sr_take_money(s,n)
{
	new t = g_SrTarget[s]
	if(!t)
		return inv_deny(s,"You are not searching anyone.")

	new why = sr_check(s,t)
	if(why >= 0)
	{
		sr_end(s,why)

		return 1
	}

	if(!sr_money_window(s))
		return sr_deny(s,"You cannot take money here.")

	if(n < 1)
		return sr_deny(s,"That is not a number.")

	new have = ARP_GetUserWallet(t)
	if(have < 1)
	{
		sr_money_sync(s)

		return sr_deny(s,"He has no money on him.")
	}

	new take = min(n,have)

	ARP_SetUserWallet(t,have - take)
	ARP_SetUserWallet(s,ARP_GetUserWallet(s) + take)

	new sname[33],tname[33],sauth[36],tauth[36],map[33]
	get_user_name(s,sname,32)
	get_user_name(t,tname,32)
	get_user_authid(s,sauth,35)
	get_user_authid(t,tauth,35)
	get_mapname(map,32)

	log_amx("[ARP] search on %s: %s<%s> took %d from the wallet of %s<%s>",map,sname,sauth,take,tname,tauth)
	ARP_Log("Search on %s: ^"%s<%s>^" took %d from the wallet of ^"%s<%s>^"",map,sname,sauth,take,tname,tauth)

	new money[48]
	inv_money(t,take,money,47)
	client_print(t,print_chat,"[ARP] %s took %s from you.",sname,money)

	new text[121]
	inv_money(s,take,money,47,true)
	formatex(text,120,"You took %s.",money)
	sr_note(s,0,text)

	sr_money_sync(s)

	// both windows show the wallet: his own and the searcher's
	inv_kick(s)
	inv_kick(t)

	return 0
}

// h9inv s <sub> ...
stock sr_command(id,const sub[],const a2[],const a3[])
{
	if(!sr_window(id))
		return 1

	if(equal(sub,"close"))
	{
		if(!g_SrTarget[id])
			return 1

		sr_end(id,SR_CLOSED)

		return 0
	}

	if(equal(sub,"take"))
	{
		new c = inv_arg(a2),n = inv_arg(a3)
		if(!g_SrTarget[id])
			return inv_deny(id,"You are not searching anyone.")

		if(c < 0 || n < 0)
			return sr_deny(id,"That is not a number.")

		return sr_take(id,c,n)
	}

	if(equal(sub,"money"))
	{
		new n = inv_arg(a2)
		if(!g_SrTarget[id])
			return inv_deny(id,"You are not searching anyone.")

		if(n < 0)
			return sr_deny(id,"That is not a number.")

		return sr_take_money(id,n)
	}

	return 1
}

// ---------------------------------------------------------------------------------------------------------------------- the plugin

public plugin_natives()
	register_library("arp_inventory")

public ARP_Error(const Reason[])
	pause("d")

public plugin_precache()
{
	arpvgui_precache()

	// variable length (-1), registered here so every game learns them as it joins
	g_MsgInv = engfunc(EngFunc_RegUserMsg,"H9Inv",-1)
	g_MsgTrade = engfunc(EngFunc_RegUserMsg,"H9Trade",-1)
	g_MsgSearch = engfunc(EngFunc_RegUserMsg,"H9Search",-1)
}

public ARP_Init()
{
	ARP_RegisterPlugin("Inventory",ARP_VERSION,"H9","Arranges a player's items in cells and draws them in a window")

	// the switches of this plugin (docs\APOLLO_RP.txt, section 9): the window, the cells a player has (0: no limit, as stock ARP), the stack limit of a
	// cell, and what the money is called in the window and in this plugin's messages
	p_Window = register_cvar("arp_h9_inv_window","1")
	p_Slots = register_cvar("arp_h9_inv_slots","32")
	p_Stack = register_cvar("arp_h9_inv_stack","20")
	p_Credits = register_cvar("arp_h9_credits","1")

	// the arrangement of the cells is kept in the database (the persistence part): 0 packs the cells at every join and writes nothing
	p_Persist = register_cvar("arp_h9_inv_persist","1")

	// the exchange of goods: the distance at which an open exchange is cancelled (units), and the seconds without a change after which it is
	p_TradeRange = register_cvar("arp_h9_trade_range","250")
	p_TradeTimeout = register_cvar("arp_h9_trade_timeout","120")

	// the search of a handcuffed player: the switch (0: the use key on a handcuffed player does what it did), and how near the searcher must stay
	p_Search = register_cvar("arp_h9_search","1")
	p_SearchRange = register_cvar("arp_h9_search_range","150")
	p_SearchMoney = register_cvar("arp_h9_search_money","1")

	ARP_RegisterEvent("Item_Inventory","EventInventory")
	ARP_RegisterEvent("Player_Ready","EventReady")
	ARP_RegisterEvent("Player_Use","EventPlayerUse")
	ARP_RegisterEvent("Player_Save","EventPlayerSave")

	inv_load_stacks()
}

public plugin_init()
{
	arpvgui_init("arpinv")

	register_clcmd("h9inv","CmdH9Inv")

	register_concmd("arp_h9_inv_dump","CmdDump",_,"<player> - lists a player's cells")
	register_concmd("arp_h9_inv_check","CmdCheck",_,"<player> - checks a player's cells against his items")

	register_event("DeathMsg","EventDeath","a")

	set_task(INV_TICK,"inv_tick",_,_,_,"b")
}

// configs\arp\inventory.ini (the map's own folder first): lines "item name|limit|icon"; # or ; starts a comment. An item it does not name uses arp_h9_inv_stack.
stock inv_load_stacks()
{
	for(new k;k <= INV_MAX_KINDS;k++)
		g_StackOf[k] = 0

	new file = ARP_FileOpen("inventory.ini","r")
	if(!file)
		return

	new line[160],name[INV_NAME_LEN + 1],rest[128],lim[16],icon[64],listed,ignored
	while(!feof(file))
	{
		fgets(file,line,159)
		trim(line)

		if(!line[0] || line[0] == '#' || line[0] == ';' || (line[0] == '/' && line[1] == '/'))
			continue

		strtok(line,name,INV_NAME_LEN,rest,127,'|')
		trim(name)
		strtok(rest,lim,15,icon,63,'|')
		trim(lim)

		new kind = inv_find_kind(name)
		if(!kind || !lim[0] || !is_str_num(lim) || strlen(lim) > 6)
		{
			ignored++
			continue
		}

		g_StackOf[kind] = clamp(str_to_num(lim),1,INV_MAX_STACK)
		listed++
	}

	fclose(file)

	log_amx("[ARP] inventory: inventory.ini names %d stack limits%s",listed,ignored ? " (some lines are not an item and a number, and are ignored)" : "")
}

// the id of the item with exactly this name (any case), or 0
stock inv_find_kind(const name[])
{
	new raw[33]
	for(new k = 1;k <= INV_MAX_KINDS && ARP_ValidItemId(k);k++)
	{
		ARP_GetItemName(k,raw,32)
		if(equali(raw,name))
			return k
	}

	return 0
}

public client_putinserver(id)
	inv_reset(id)

public client_disconnect(id)
{
	tr_gone(id,TR_THEY_LEFT)
	sr_left(id)

	// ARP_Core's Player_Save has written the arrangement already when it was changed; this is for a disconnect it did not save for
	inv_db_save(id)
	inv_reset(id)
}

// the map changes: an exchange that is open is closed for both
public plugin_end()
{
	for(new id = 1;id <= MAX_PLAYERS;id++)
	{
		if(g_TrState[id] != TR_IDLE)
			tr_tell(id,TR_MAP_CHANGE,"")

		if(g_SrTarget[id])
			sr_end(id,SR_OFF)
	}
}

// the player's character has loaded: the cells are made from his items
public InvAttach(id)
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id))
		return 0

	inv_reset(id)
	g_On[id] = 1
	inv_pack(id)
	inv_db_load(id)

	return 1
}

// the plugin was paused and is running again: what happened meanwhile did not reach the cells, so they are made again from the items of every player
// whose character has loaded
public plugin_unpause()
{
	new players[MAX_PLAYERS],num
	get_players(players,num)

	for(new i;i < num;i++)
		if(!is_user_bot(players[i]) && ARP_PlayerReady(players[i]))
			InvAttach(players[i])
}

public EventReady(Name[],Data[],Len)
{
	InvAttach(Data[0])

	return PLUGIN_CONTINUE
}

// /items and /inventory: a game that has the window is given it in place of the text menu
public EventInventory(Name[],Data[],Len)
{
	new id = Data[0]
	if(!inv_window(id))
		return PLUGIN_CONTINUE

	inv_open(id)

	return PLUGIN_HANDLED
}

// the use key was pressed on a player (ARP_Core's Player_Use): the context menu takes the press when ARP_H9Ctx is there and gives it one (below); else an exchange is
// offered to him, or his offer is accepted
public EventPlayerUse(Name[],Data[],Len)
{
	if(!ctx_takes(Data[0],Data[1]))
		tr_use(Data[0],Data[1])

	return PLUGIN_CONTINUE
}

// ---------------------------------------------------------------------------------------------------------------------- the context menu (ARP_H9Ctx)
//
// With arp_h9_ctxmenu 1 the use key on a player opens ARP_H9Ctx's menu, whose entries Trade, Search and Show are this plugin's. The menu asks what each may do (H9Inv_CtxWhy:
// the tests of tr_use, sr_use and inv_op_show made without a side effect, and the reason in the words the menu shows) and has it done through the functions the use key and the
// window run (H9Inv_CtxDo, H9Inv_CtxShow), so there is no second implementation of any rule. With ARP_H9Ctx not loaded, or its switch off, the use key is what it was.

// whether the use key on target is the menu's: 1 when ARP_H9Ctx has put the menu up for the player. The press that accepts an invitation is never the menu's.
stock ctx_takes(id,target)
{
	if(id < 1 || id > MAX_PLAYERS || target < 1 || target > MAX_PLAYERS)
		return 0

	if(g_TrState[id] == TR_INVITED && g_TrPartner[id] == target)
		return 0

	// callfunc_begin never asks whether the other plugin runs, so a paused ARP_H9Ctx would still be called and nothing would serve its menu: the plugin is found by its file and the
	// function by its id, and callfunc_begin_i answers 1 only for a plugin that can run
	new pid = find_plugin_byfile("ARP_H9Ctx.amxx")
	if(pid < 0)
		return 0

	new fid = get_func_id("H9Ctx_Press",pid)
	if(fid < 0)
		return 0

	if(callfunc_begin_i(fid,pid) != 1)
		return 0

	callfunc_push_int(id)
	callfunc_push_int(target)

	return callfunc_end()
}

// a player's state in the exchange as tr_expire would leave it: an invitation that has lapsed is none
stock ctx_tr_state(id,Float:now)
{
	new s = g_TrState[id]
	if((s == TR_INVITING || s == TR_INVITED) && now >= g_TrUntil[id])
		return TR_IDLE

	return s
}

// why the use key on target could not offer id an exchange now, in the order tr_use asks; nothing when it could
stock ctx_why_trade(id,target,why[],len)
{
	new Float:now = get_gametime(),mine = ctx_tr_state(id,now),theirs = ctx_tr_state(target,now)

	if(!g_On[id] || !is_user_alive(id))
		copy(why,len,"You cannot do that now")
	else if(mine == TR_INVITED && g_TrPartner[id] == target)
		why[0] = 0
	else if(g_SrTarget[id])
		copy(why,len,"Finish your search first")
	else if(mine == TR_TRADING)
		copy(why,len,"You are in an exchange")
	else if(mine == TR_INVITING)
		copy(why,len,"Wait for his answer")
	else if(mine == TR_INVITED)
		copy(why,len,"Answer the offer first")
	else if(!inv_window(id))
		copy(why,len,"You have no inventory window")
	else if(is_user_bot(target))
		copy(why,len,"Bots cannot trade")
	else if(!is_user_alive(target))
		copy(why,len,"He is dead")
	else if(!g_On[target])
		copy(why,len,"He is not ready")
	else if(tr_restrained(id))
		copy(why,len,"You are cuffed or jailed")
	else if(tr_restrained(target))
	{
		if(get_pcvar_num(p_Search))
			copy(why,len,"He is cuffed: search him")
		else
			copy(why,len,"He is cuffed")
	}
	else if(!inv_window(target))
		copy(why,len,"He has no inventory window")
	else if(theirs != TR_IDLE || g_SrTarget[target])
		copy(why,len,"He is busy")
	else if(g_CoolWith[id] == target && now < g_CoolUntil[id])
		copy(why,len,"Wait a moment")
	else if(now - g_InviteAt[id] < TR_INVITE_GAP && now >= g_InviteAt[id])
		copy(why,len,"Wait a moment")
}

// why the use key on target could not open a search for id now, in the order sr_use asks; nothing when it could
stock ctx_why_search(id,target,why[],len)
{
	new Float:now = get_gametime()

	if(!get_pcvar_num(p_Search))
		copy(why,len,"Searching is off")
	else if(!g_On[id] || !is_user_alive(id))
		copy(why,len,"You cannot do that now")
	else if(!tr_restrained(target))
		copy(why,len,"Cuff him first")
	else if(!sr_window(id))
		copy(why,len,"You have no search window")
	else if(is_user_bot(target))
		copy(why,len,"Bots cannot be searched")
	else if(tr_restrained(id))
		copy(why,len,"You are cuffed or jailed")
	else if(g_SrBy[id])
		copy(why,len,"You are being searched")
	else if(!is_user_alive(target))
		copy(why,len,"He is dead")
	else if(!g_On[target])
		copy(why,len,"He is not ready")
	else if(g_SrTarget[id] == target)
		why[0] = 0
	else if(ctx_tr_state(id,now) != TR_IDLE)
		copy(why,len,"Finish your exchange first")
	else if(g_SrBy[target] && g_SrBy[target] != id)
		copy(why,len,"Somebody is searching him")
}

// why id could not show an item to target now (inv_op_show's own test); nothing when he could
stock ctx_why_show(id,target,why[],len)
{
	if(!g_On[id] || !is_user_alive(id))
		copy(why,len,"You cannot do that now")
	else if(is_user_bot(target))
		copy(why,len,"Bots cannot see it")
	else if(!inv_near(id,target,INV_SHOW_RANGE))
		copy(why,len,"Not near enough")
}

// H9Inv_CtxWhy(id, target, what, why[], len): what 1 is the exchange, 2 the search, 3 the show of an item. Returns 1 when the press could do it now, and why is empty;
// 0 when not, and why says it in a few words. Nothing is changed and nothing is sent.
public H9Inv_CtxWhy(id,target,what,why[],len)
{
	why[0] = 0

	if(id < 1 || id > MAX_PLAYERS || target < 1 || target > MAX_PLAYERS || id == target || !is_user_connected(id) || !is_user_connected(target))
		copy(why,len,"Not available")
	else if(what == 1)
		ctx_why_trade(id,target,why,len)
	else if(what == 2)
		ctx_why_search(id,target,why,len)
	else if(what == 3)
		ctx_why_show(id,target,why,len)
	else
		copy(why,len,"Not available")

	return why[0] ? 0 : 1
}

// H9Inv_CtxDo(id, target, what): what 1 offers target an exchange (or accepts his offer), what 2 opens the search of him, as the use key does it. Returns 1 when it was done.
public H9Inv_CtxDo(id,target,what)
{
	new why[40]
	if(!H9Inv_CtxWhy(id,target,what,why,39))
	{
		if(why[0])
			inv_note(id,1,why)

		return 0
	}

	if(what == 1)
		tr_use(id,target)
	else
		sr_use(id,target)

	return 1
}

// H9Inv_CtxShow(id, target, kind): the first cell of id's that holds that kind is shown to target, as the window's SHOW TO does it. Returns 1 when it was.
public H9Inv_CtxShow(id,target,kind)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id] || kind < 1)
		return 0

	for(new c;c < inv_cells(id);c++)
		if(g_CK[id][c] == kind)
			return inv_op_show(id,c,target) ? 0 : 1

	inv_note(id,1,"You do not have that.")

	return 0
}

public EventDeath()
{
	new victim = read_data(2)

	if(victim < 1 || victim > MAX_PLAYERS)
		return

	if(g_TrState[victim] != TR_IDLE)
		tr_finish(victim,g_TrPartner[victim],TR_YOU_DIED,TR_THEY_DIED,"")

	sr_died(victim)

	inv_close(victim,1)
}

// the window is asked for: the header, the catalog of what the cells hold and the cells are sent
stock inv_open(id)
{
	g_Open[id] = 1
	g_PendOpen[id] = 1

	inv_flush(id)
}

// every quarter of a second the open windows are brought up to date (the money, and what other plugins changed); every second the limits are looked at
public inv_tick()
{
	static ticks
	ticks++

	new players[MAX_PLAYERS],num
	get_players(players,num)

	for(new i;i < num;i++)
		if(g_On[players[i]] && g_Open[players[i]])
			inv_flush(players[i])

	tr_tick(ticks % 4 == 0)

	if(ticks % 4 == 0)
	{
		inv_poll(players,num)
		inv_db_pass(players,num)
		sr_tick()
	}
}

// AMX Mod X cvar hooks do not fire on H9 servers, so the limits are read once a second: a change of the cell limit or the stack limit arranges every
// player's cells to it (nothing is cut: a player over a lowered limit keeps his cells)
stock inv_poll(const players[],num)
{
	new slots = inv_slots(),stack = clamp(get_pcvar_num(p_Stack),1,INV_MAX_STACK)

	if(slots == g_LastSlots && stack == g_LastStack)
		return

	new first = g_LastSlots == -1
	g_LastSlots = slots
	g_LastStack = stack

	if(first)
		return

	for(new i;i < num;i++)
		if(g_On[players[i]])
			inv_normalize(players[i])
}

// ---------------------------------------------------------------------------------------------------------------------- the core's hooks

// a count of the player's items is about to change: returns the count to keep plus one (0: no opinion, for a player whose cells are not made yet)
public ARP_InvOnCount(id,kind,oldnum,newnum)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id])
		return 0

	return inv_count_changed(id,kind,oldnum,newnum) + 1
}

// how many of qty fit, plus one
public ARP_InvOnRoom(id,kind,qty)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id] || kind < 1 || kind > INV_MAX_KINDS)
		return 0

	if(!inv_slots())
		return qty + 1

	return min(inv_room(g_CK[id],g_CN[id],g_Res[id],kind,inv_cap()),qty) + 1
}

// an item's use begins and ends
public ARP_InvOnUse(id,kind,begin)
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id] || kind < 1 || kind > INV_MAX_KINDS)
		return

	if(begin)
	{
		g_UseKind[id] = kind
		g_UseCell[id] = g_ActKind[id] == kind ? g_ActCell[id] : -1
		g_UseSlack[id] = 0

		return
	}

	inv_settle(id,kind)

	g_UseKind[id] = 0
	g_UseCell[id] = -1
	g_UseSlack[id] = 0
}

// a line for the player about his items
public ARP_InvOnNote(id,level,const text[])
{
	if(id < 1 || id > MAX_PLAYERS || !g_On[id])
		return 0

	inv_note(id,level,text)

	return 1
}

// ---------------------------------------------------------------------------------------------------------------------- the client command

// a non-negative number of at most nine digits, or -1
stock inv_arg(const a[])
{
	if(!a[0] || strlen(a) > 9 || !is_str_num(a))
		return -1

	new n = str_to_num(a)

	return n < 0 ? -1 : n
}

public CmdH9Inv(id)
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id))
		return PLUGIN_HANDLED

	// ten commands a second; the rest are dropped without a word
	new Float:now = get_gametime()
	if(now - g_CmdAt[id] >= 1.0 || now < g_CmdAt[id])
	{
		g_CmdAt[id] = now
		g_CmdCount[id] = 0
	}

	if(++g_CmdCount[id] > 10)
		return PLUGIN_HANDLED

	// the arguments joined by single spaces (read_args keeps the quotes a command line was given with)
	new line[128],arg[32]
	for(new i = 1;i < read_argc() && i < 8;i++)
	{
		read_argv(i,arg,31)
		
		if(i > 1)
			add(line,127," ")
		
		add(line,127,arg)
	}

	InvLine(id,line)

	return PLUGIN_HANDLED
}

// h9inv <op> <args>, as the client sends it (and as a test sends it for a player who has no client). Every argument is checked here. Returns 1 when
// something was done, 0 when not (the player has been told why when there was a reason).
public InvLine(id,const Line[])
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || !g_On[id])
		return 0

	new op[16],a1[24],a2[24],a3[24],a4[24]
	parse(Line,op,15,a1,23,a2,23,a3,23,a4,23)

	if(equal(op,"close"))
	{
		inv_close(id,0)

		return 1
	}

	if(!inv_window(id))
		return 0

	if(equal(op,"open"))
	{
		if(is_user_alive(id))
			inv_open(id)

		return 1
	}

	if(!is_user_alive(id))
	{
		inv_deny(id,"You are dead.")

		return 0
	}

	new rc = 1

	if(equal(op,"tidy"))
		rc = inv_op_tidy(id)
	else if(equal(op,"move"))
	{
		new f = inv_arg(a1),t = inv_arg(a2)
		rc = (f < 0 || t < 0) ? inv_deny(id,"That is not a command.") : inv_op_move(id,f,t)
	}
	else if(equal(op,"split"))
	{
		new s = inv_arg(a1),n = inv_arg(a2),t = -1,bad
		if(s < 0 || n < 0)
			bad = 1
		else if(a3[0])
		{
			t = inv_arg(a3)
			if(t == 255)
				t = -1
			else if(t < 0)
				bad = 1
		}

		rc = bad ? inv_deny(id,"That is not a command.") : inv_op_split(id,s,n,t)
	}
	else if(equal(op,"use"))
	{
		new c = inv_arg(a1)
		rc = c < 0 ? inv_deny(id,"That is not a command.") : inv_op_use(id,c)
	}
	else if(equal(op,"drop"))
	{
		new c = inv_arg(a1),n = inv_arg(a2)
		rc = (c < 0 || n < 0) ? inv_deny(id,"That is not a command.") : inv_op_drop(id,c,n)
	}
	else if(equal(op,"give"))
	{
		new c = inv_arg(a1),n = inv_arg(a2),p = inv_arg(a3)
		rc = (c < 0 || n < 0 || p < 0) ? inv_deny(id,"That is not a command.") : inv_op_give(id,c,n,p)
	}
	else if(equal(op,"show"))
	{
		new c = inv_arg(a1),p = inv_arg(a2)
		rc = (c < 0 || p < 0) ? inv_deny(id,"That is not a command.") : inv_op_show(id,c,p)
	}
	else if(equal(op,"info"))
	{
		new k = inv_arg(a1)
		rc = k < 0 ? inv_deny(id,"That is not a command.") : inv_op_info(id,k)
	}
	else if(equal(op,"x"))
		rc = tr_command(id,a1,a2,a3,a4)
	else if(equal(op,"s"))
		rc = sr_command(id,a1,a2,a3)
	else
		return 0

	inv_flush(id)

	return rc ? 0 : 1
}

// ---------------------------------------------------------------------------------------------------------------------- checks the server console can ask for

// a player by his number (1 to the slots) or a part of his name
stock inv_target(const arg[])
{
	if(!arg[0])
		return 0

	if(is_str_num(arg))
	{
		new n = str_to_num(arg)

		return (n >= 1 && n <= MAX_PLAYERS && is_user_connected(n)) ? n : 0
	}

	new players[MAX_PLAYERS],num,name[33]
	get_players(players,num)

	for(new i;i < num;i++)
	{
		get_user_name(players[i],name,32)
		if(containi(name,arg) != -1)
			return players[i]
	}

	return 0
}

// the first thing wrong with a player's cells, as text (the number of things wrong is returned; -1 when he has no arrangement)
stock inv_check(id,why[],len)
{
	why[0] = 0

	if(!g_On[id])
	{
		copy(why,len,"his cells are not made")

		return -1
	}

	new bad

	for(new c;c < INV_MAX_CELLS;c++)
	{
		new kind = g_CK[id][c],n = g_CN[id][c]

		if(!kind)
		{
			if(n && !bad++)
				formatex(why,len,"cell %d is empty but holds a count of %d",c,n)

			continue
		}

		if(kind < 1 || kind > INV_MAX_KINDS || !ARP_ValidItemId(kind))
		{
			if(!bad++)
				formatex(why,len,"cell %d holds the unknown item %d",c,kind)

			continue
		}

		if(n < 1 && !bad++)
			formatex(why,len,"cell %d holds a count of %d",c,n)

		if(n > inv_stackmax(kind) && !g_Over[id] && !bad++)
			formatex(why,len,"cell %d holds %d, over the stack limit %d",c,n,inv_stackmax(kind))

		if(g_Res[id][c] > n && !bad++)
			formatex(why,len,"cell %d is reserved for %d but holds %d",c,g_Res[id][c],n)
	}

	for(new kind = 1;kind <= INV_MAX_KINDS && ARP_ValidItemId(kind);kind++)
	{
		new have = inv_have(g_CK[id],g_CN[id],kind),total = ARP_GetUserItemNum(id,kind)
		if(have != total)
		{
			if(!bad)
				formatex(why,len,"item %d: the cells hold %d, the count is %d",kind,have,total)

			bad++
		}
	}

	return bad
}

// arp_h9_inv_dump <player>: the arrangement of a player
public CmdDump(id,level,cid)
{
	if(!ARP_CmdAccess(id,cid,2))
		return PLUGIN_HANDLED

	new arg[33],target
	read_argv(1,arg,32)
	target = inv_target(arg)

	if(!target)
	{
		console_print(id,"[ARP] There is no such player.")

		return PLUGIN_HANDLED
	}

	console_print(id,"DUMP id=%d on=%d slots=%d shown=%d used=%d over=%d lost=%d repairs=%d open=%d",target,g_On[target],inv_slots(),inv_shown(target),inv_used(g_CK[target]),g_Over[target],g_Lost[target],g_Repairs[target],g_Open[target])
	console_print(id,"DB persist=%d key=%d saved=%d pending=%d writes=%d reads=%d applied=%d",get_pcvar_num(p_Persist),g_DbKey[target][0] ? 1 : 0,g_DbSig[target] == inv_db_sig(target) ? 1 : 0,g_DbPending[target],g_DbWrites,g_DbReads,g_DbApplied)
	console_print(id,"SEARCH searching=%d searched_by=%d",g_SrTarget[target],g_SrBy[target])

	new line[200],len,count
	for(new c;c < INV_MAX_CELLS;c++)
	{
		if(!g_CK[target][c])
			continue

		if(g_Res[target][c])
			len += formatex(line[len],199 - len,"%d:%d:%d:%d ",c,g_CK[target][c],g_CN[target][c],g_Res[target][c])
		else
			len += formatex(line[len],199 - len,"%d:%d:%d ",c,g_CK[target][c],g_CN[target][c])

		if(++count % 16 == 0)
		{
			console_print(id,"C %s",line)
			len = 0
			line[0] = 0
		}
	}

	if(len)
		console_print(id,"C %s",line)

	return PLUGIN_HANDLED
}

// arp_h9_inv_check <player>: whether his cells agree with his items
public CmdCheck(id,level,cid)
{
	if(!ARP_CmdAccess(id,cid,2))
		return PLUGIN_HANDLED

	new arg[33],target,why[128]
	read_argv(1,arg,32)
	target = inv_target(arg)

	if(!target)
	{
		console_print(id,"[ARP] There is no such player.")

		return PLUGIN_HANDLED
	}

	new bad = inv_check(target,why,127)
	if(bad)
		console_print(id,"CHECK id=%d FAIL %d: %s",target,bad,why)
	else
		console_print(id,"CHECK id=%d OK",target)

	return PLUGIN_HANDLED
}
