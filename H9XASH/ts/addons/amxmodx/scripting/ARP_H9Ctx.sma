#include <amxmodx>
#include <fakemeta>
#include <engine>
#include <ApolloRP>
#include <ApolloRP_VGui>
#include <ApolloRP_H9Ctx>

// H9: ARP_H9Ctx -- the context menu of the use key on a player.
//
// The use key on a living player (ARP_Core's event Player_Use) used to mean one thing, the exchange of goods, and for a handcuffed player the search. With
// arp_h9_ctxmenu 1 a player whose game draws the menu (_h9vgui 10, H9VGUI_CTXMENU_PROTOCOL) is shown a cursor menu of what he can do to that player instead:
// Trade, Search, Cuff or Free, Tie or Untie, Tape or Remove tape, Fine (police), Give money and Show (a license or a card), and the entries other plugins add
// (include\ApolloRP_H9Ctx.inc). An entry that does not apply now is listed and greyed with the reason; an entry whose feature is switched off on the server
// (arp_h9_inv_window, arp_h9_search, arp_h9_restraints, or this plugin's own arp_h9_ctx_cuff, _fine and _give) is not listed. Every other player, and a server
// with arp_h9_ctxmenu 0, has the use key as it was: ARP_Inventory asks this plugin (H9Ctx_Press) before it offers an exchange, and an answer of 0 leaves the press
// to it.
//
// This plugin decides what is enabled and says why, from the rules the actions already have: ARP_Inventory answers for the exchange, the search and the show
// (H9Inv_CtxWhy), ARP_JailMod and ARP_Items for what a player is held by (H9_Cuffed, H9_RopeState), and the item, wallet and job natives for the rest. The menu is
// built again every half second while it is up (and the player told of a change), and again when a choice arrives: a choice is carried out only when the entry is
// still in the menu and enabled, whatever the client sent. The actions that act on the player looked at (cuffs, rope, tape, a fine, money) run as the player's own
// command does, with his aim turned toward the player the menu is about for the length of the call (ctx_pin), so the target is the menu's and never whoever
// stands in the crosshair when the click comes.
//
// The menu is the user message H9Ctx (server to client) and the client command "h9ctx pick <serial> <index>" and "h9ctx close <serial>"; docs\ARP_INVENTORY.txt,
// 10, has the byte layout. Switches: arp_h9_ctxmenu, arp_h9_ctx_range, arp_h9_ctx_cuff, arp_h9_ctx_fine, arp_h9_ctx_give, arp_h9_ctx_fine_amounts and
// arp_h9_ctx_give_amounts.

#pragma dynamic 8192

#define CTX_ROWS         12      // rows of a page; the first ten have a number key
#define CTX_LABEL_LEN    24
#define CTX_NOTE_LEN     34
#define CTX_KEY_LEN      28
#define CTX_NAME_LEN     33
#define CTX_HANDLER_LEN  32
#define CTX_EXTRA_MAX    4       // entries of other plugins on the first page
#define CTX_AMOUNTS      8       // amounts on a page of money
#define CTX_MSG_MAX      188     // bytes of one user message (include\h9_vgui.inc, H9VGUI_MSG_MAX)
#define CTX_TICK         0.5     // seconds between the passes over the menus that are up
#define CTX_DOCS_MAX     8       // licenses and cards on the page of the show

// the first _h9vgui whose game reads the user message H9Ctx and draws the menu (include\h9_vgui.inc has no name for it)
#if !defined H9VGUI_CTXMENU_PROTOCOL
	#define H9VGUI_CTXMENU_PROTOCOL 10
#endif

// the user message H9Ctx, server to client: the first byte of each is its op
#define CTX_OP_OPEN      1       // byte serial, byte flags (bit 0: the menu is the same one, refreshed), byte page, byte rows, string title, string line under it
#define CTX_OP_ROWS      2       // byte serial, byte first row, byte count, then for each: byte flags, byte key, string label, string note
#define CTX_OP_CLOSE     3       // byte serial (0: whatever is up), byte reason
#define CTX_OP_NOTE      4       // byte serial, byte level (0 plain, 1 refusal), string text

// the flags of a row
#define CTXF_ON          1       // it can be chosen
#define CTXF_MORE        2       // it opens a page of choices
#define CTXF_RED         4       // drawn in red
#define CTXF_GAP         8       // a blank half row above it

// the reasons of a CLOSE
#define CTXC_SERVER      0       // the switch went off, or his game cannot draw the menu any more
#define CTXC_TARGET      1       // the player the menu is about is gone or dead
#define CTXC_FAR         2       // he went too far from him
#define CTXC_DONE        3       // a choice was carried out
#define CTXC_DIED        4       // the player died or was restrained

// the pages
#define CTXP_MAIN        0
#define CTXP_FINE        1
#define CTXP_GIVE        2
#define CTXP_SHOW        3

// what H9Inv_CtxWhy is asked about
#define CTXW_TRADE       1
#define CTXW_SEARCH      2
#define CTXW_SHOW        3

// what H9_RopeState answers: bit 0 he is tied, bit 1 he holds somebody on a rope, bit 2 his mouth is taped
#define ROPE_TIED        1
#define ROPE_HOLDS       2
#define ROPE_TAPED       4

// the ranges of the commands this plugin runs (get_user_aiming's, in the plugins that have them)
#define RANGE_CUFF       200     // ARP_JailMod's SayCuff
#define RANGE_MONEY      200     // ARP_Commands' /fine and /givemoney
#define RANGE_RESTRAINT  100     // ARP_Items' rope and tape

new p_On
new p_Range
new p_Cuff
new p_Fine
new p_Give
new p_FineAmounts
new p_GiveAmounts

new g_MsgCtx

// each player's menu: its serial (0: none is up), the player it is about, its page, and what was last sent of it
new g_Serial[MAX_PLAYERS + 1]
new g_Last[MAX_PLAYERS + 1]                      // the last serial he was given
new g_Target[MAX_PLAYERS + 1]
new g_Page[MAX_PLAYERS + 1]
new g_Rows[MAX_PLAYERS + 1]
new g_Sig[MAX_PLAYERS + 1]
new g_RowKey[MAX_PLAYERS + 1][CTX_ROWS][CTX_KEY_LEN]
new Float:g_CmdAt[MAX_PLAYERS + 1]              // his h9ctx commands in this second
new g_CmdCount[MAX_PLAYERS + 1]
new g_Up                                         // menus that are up: the pass over them runs only while there is one

// the page being built: the rows, and what the one that is being added by another plugin is
new g_BN
new g_BPage
new g_BExtra
new g_BKey[CTX_ROWS][CTX_KEY_LEN]
new g_BLabel[CTX_ROWS][CTX_LABEL_LEN]
new g_BNote[CTX_ROWS][CTX_NOTE_LEN]
new g_BFlags[CTX_ROWS]
new g_BPlugin[CTX_ROWS]                          // the plugin that added the row (0: this one's own)
new g_BHandler[CTX_ROWS][CTX_HANDLER_LEN]
new g_BKind[CTX_ROWS]                            // the item a page of the show row stands for
new g_BTitle[CTX_NAME_LEN + 1]
new g_BSub[CTX_NAME_LEN + 1]
new g_Building                                   // ARP_H9CtxBuild is running, so ARP_H9CtxAdd takes an entry

// the items the actions use, by name; found once the items are registered
new g_ItLooked
new g_ItCuffs
new g_ItRope
new g_ItTape

// the aim that ctx_pin gave back at ctx_unpin
new Float:g_AimSave[3]
new g_Pinned

// ---------------------------------------------------------------------------------------------------------------------- the plugin

public plugin_natives()
{
	register_library("arp_h9ctx")
	register_native("ARP_H9CtxAdd","_ARP_H9CtxAdd")
}

public ARP_Error(const Reason[])
	pause("d")

public plugin_precache()
{
	arpvgui_precache()

	// variable length (-1), registered here so every game learns it as it joins
	g_MsgCtx = engfunc(EngFunc_RegUserMsg,"H9Ctx",-1)
}

public ARP_Init()
{
	ARP_RegisterPlugin("Context menu",ARP_VERSION,"H9","The menu of the use key on a player")

	// the switches of this plugin (docs\APOLLO_RP.txt, section 10): the menu itself (0: the use key does what it did), how near the player must stay, the entries that
	// no other switch is behind, and the amounts of the two pages of money
	p_On = register_cvar("arp_h9_ctxmenu","0")
	p_Range = register_cvar("arp_h9_ctx_range","150")
	p_Cuff = register_cvar("arp_h9_ctx_cuff","1")
	p_Fine = register_cvar("arp_h9_ctx_fine","1")
	p_Give = register_cvar("arp_h9_ctx_give","1")
	p_FineAmounts = register_cvar("arp_h9_ctx_fine_amounts","50 100 250 500 1000")
	p_GiveAmounts = register_cvar("arp_h9_ctx_give_amounts","10 50 100 500 1000")
}

public plugin_init()
{
	arpvgui_init("arpctx")

	register_clcmd("h9ctx","CmdH9Ctx")

	register_concmd("arp_h9_ctx_dump","CmdDump",_,"<user> [<target>] - lists the menu a player has up, or the one he would be shown on the target")

	register_event("DeathMsg","EventDeath","a")

	set_task(CTX_TICK,"ctx_tick",_,_,_,"b")
}

public client_putinserver(id)
	ctx_reset(id)

public client_disconnect(id)
{
	ctx_reset(id)

	// a menu about him is over
	for(new i = 1;i <= MAX_PLAYERS;i++)
		if(g_Serial[i] && g_Target[i] == id)
			ctx_close(i,CTXC_TARGET)
}

public EventDeath()
{
	new victim = read_data(2)
	if(victim < 1 || victim > MAX_PLAYERS)
		return

	ctx_close(victim,CTXC_DIED)

	for(new i = 1;i <= MAX_PLAYERS;i++)
		if(g_Serial[i] && g_Target[i] == victim)
			ctx_close(i,CTXC_TARGET)
}

// ---------------------------------------------------------------------------------------------------------------------- small helpers

// ASCII only (and the single byte of the credit sign), and nothing the client's printf or the engine's string handling would act on
stock ctx_clean(const src[],dst[],len)
{
	new i
	for(;src[i] && i < len - 1;i++)
		dst[i] = ((src[i] < 32 || src[i] > 126) && src[i] != ARP_CREDIT_BYTE) || src[i] == '%' || src[i] == '^^' ? '?' : src[i]

	dst[i] = 0
}

// a number of one to nine digits, or -1
stock ctx_num(const a[])
{
	if(!a[0] || strlen(a) > 9 || !is_str_num(a))
		return -1

	return str_to_num(a)
}

// the value of another plugin's cvar, by name (0 when it is not registered)
stock ctx_cv(const name[])
{
	new p = get_cvar_pointer(name)

	return p ? get_pcvar_num(p) : 0
}

// what a public function of another plugin answers for one player: the number it returns, or def when the plugin or the function is not there
stock ctx_ask(const plugin[],const func[],id,def = 0)
{
	if(callfunc_begin(func,plugin) != 1)
		return def

	callfunc_push_int(id)

	return callfunc_end()
}

// whether he is cuffed (not just in jail) and what a rope and tape say of him; a JailMod or Items without the functions says he is held by nothing
stock ctx_cuffed(id)
	return ctx_ask("ARP_JailMod.amxx","H9_Cuffed",id)

stock ctx_restrained(id)
	return ctx_ask("ARP_JailMod.amxx","H9_Restrained",id)

stock ctx_rope(id)
	return ctx_ask("ARP_Items.amxx","H9_RopeState",id)

// an item's id by its exact name (any case), or 0
stock ctx_find_item(const name[])
{
	new raw[33]
	for(new k = 1;k <= 255 && ARP_ValidItemId(k);k++)
	{
		ARP_GetItemName(k,raw,32)
		if(equali(raw,name))
			return k
	}

	return 0
}

// the ids of the items the actions use; looked for once the first menu is built, when every plugin has registered its items
stock ctx_items()
{
	if(g_ItLooked)
		return

	g_ItLooked = 1
	g_ItCuffs = ctx_find_item("Cuffs")
	g_ItRope = ctx_find_item("Rope")
	g_ItTape = ctx_find_item("Tape")
}

// the money as a row says it: the credit sign and the digits to a player who is shown the sign, "100 credits" in credits mode to one who is not, "$100" in cash mode
stock ctx_money(id,amount,out[],len)
{
	if(!ctx_cv("arp_h9_credits"))
		formatex(out,len - 1,"$%d",amount)
	else if(arp_credit_sign(id))
		formatex(out,len - 1,"^xA2;%d",amount)
	else
		formatex(out,len - 1,"%d credit%s",amount,amount == 1 ? "" : "s")
}

// a hash of text, for telling whether the menu changed
stock ctx_hash(const s[],h)
{
	for(new i;s[i];i++)
		h = (h * 16777619) ^ (s[i] & 255)

	return h
}

// ---------------------------------------------------------------------------------------------------------------------- the aim

// The commands that act on the player looked at ask get_user_aiming, which reads the player's view. ctx_pin turns the view toward the target for the length of one call and
// ctx_unpin gives it back: nothing reaches the client, and the next command of the client overwrites the view in any case.
stock bool:ctx_pin(id,target)
{
	new Float:eye[3],Float:view[3],Float:to[3],Float:angles[3]
	pev(id,pev_origin,eye)
	pev(id,pev_view_ofs,view)
	pev(target,pev_origin,to)

	new Float:dx = to[0] - (eye[0] + view[0]),Float:dy = to[1] - (eye[1] + view[1]),Float:dz = to[2] - (eye[2] + view[2])
	new Float:len = floatsqroot(dx * dx + dy * dy + dz * dz)
	if(len < 1.0)
		return false

	// a player's view has its pitch positive downward (AngleVectors: forward z = -sin(pitch))
	angles[0] = -floatasin(dz / len,degrees)
	angles[1] = floatatan2(dy,dx,degrees)
	angles[2] = 0.0

	pev(id,pev_v_angle,g_AimSave)
	set_pev(id,pev_v_angle,angles)
	g_Pinned = id

	return true
}

stock ctx_unpin(id)
{
	if(g_Pinned == id)
	{
		set_pev(id,pev_v_angle,g_AimSave)
		g_Pinned = 0
	}
}

// a view that is still pinned when one of this plugin's functions starts was left so by a command that raised an error (the error ends the function that called it, and callfunc
// hands it on): it is put back before anything else reads it
stock ctx_sweep_pin()
{
	if(g_Pinned)
		ctx_unpin(g_Pinned)
}

// 0: from the player's eye the target is what get_user_aiming finds within range; 1: he is further than that; 2: something stands in the way
stock ctx_reach(id,target,range)
{
	if(!ctx_pin(id,target))
		return 2

	new hit,body,res
	get_user_aiming(id,hit,body,range)

	if(hit != target)
	{
		get_user_aiming(id,hit,body,4096)
		res = hit == target ? 1 : 2
	}

	ctx_unpin(id)

	return res
}

// why a command that needs the target in the crosshair cannot be run now, as text for the row; "" when it can
stock ctx_reach_why(id,target,range,why[],len)
{
	switch(ctx_reach(id,target,range))
	{
		case 1:
			copy(why,len,"Too far")
		case 2:
			copy(why,len,"Not in sight")
		default:
			why[0] = 0
	}
}

// the distance between two players' origins
stock Float:ctx_dist(a,b)
{
	new Float:oa[3],Float:ob[3]
	pev(a,pev_origin,oa)
	pev(b,pev_origin,ob)

	return get_distance_f(oa,ob)
}

// ---------------------------------------------------------------------------------------------------------------------- the rows

// adds a row; with `why` it is greyed with that reason, else it is enabled and `note` is its small detail. Returns the row, or -1 when the page is full.
stock ctx_add(const key[],const label[],const why[],flags = 0,const note[] = "")
{
	if(g_BN >= CTX_ROWS)
		return -1

	new r = g_BN++

	copy(g_BKey[r],CTX_KEY_LEN - 1,key)
	ctx_clean(label,g_BLabel[r],CTX_LABEL_LEN)

	if(why[0])
		ctx_clean(why,g_BNote[r],CTX_NOTE_LEN)
	else
		ctx_clean(note,g_BNote[r],CTX_NOTE_LEN)

	g_BFlags[r] = flags | (why[0] ? 0 : CTXF_ON)
	g_BPlugin[r] = 0
	g_BHandler[r][0] = 0
	g_BKind[r] = 0

	return r
}

// ARP_Inventory's answer for the exchange, the search and the show: when it cannot be done now, why holds the reason
stock ctx_inv_why(id,target,what,why[],len)
{
	why[0] = 0

	if(callfunc_begin("H9Inv_CtxWhy","ARP_Inventory.amxx") != 1)
	{
		copy(why,len,"Not available")

		return 0
	}

	// a pushed string has the room of its own length alone, so it goes as len blanks for the answer to be written in
	new text[CTX_NOTE_LEN + 1]
	for(new i;i < len && i < CTX_NOTE_LEN;i++)
		text[i] = ' '

	callfunc_push_int(id)
	callfunc_push_int(target)
	callfunc_push_int(what)
	callfunc_push_str(text,true)
	callfunc_push_int(len)

	new rc = callfunc_end()

	trim(text)
	copy(why,len,text)

	return rc
}

// the first page: the rows in the order the owner reads them
stock ctx_e_trade(id,target)
{
	if(!ctx_cv("arp_h9_inv_window"))
		return

	new why[CTX_NOTE_LEN]
	ctx_inv_why(id,target,CTXW_TRADE,why,CTX_NOTE_LEN - 1)
	ctx_add("trade","Trade",why)
}

stock ctx_e_search(id,target)
{
	if(!ctx_cv("arp_h9_search"))
		return

	new why[CTX_NOTE_LEN]
	ctx_inv_why(id,target,CTXW_SEARCH,why,CTX_NOTE_LEN - 1)
	ctx_add("search","Search",why)
}

// Cuff, or Free when he is cuffed already: the rules of ARP_JailMod's SayCuff, which runs it
stock ctx_e_cuff(id,target)
{
	if(!get_pcvar_num(p_Cuff))
		return

	new why[CTX_NOTE_LEN],cop = ARP_IsCop(id) ? 1 : 0,cuffed = ctx_cuffed(target)

	if(!cop)
	{
		if(!g_ItCuffs)
			copy(why,CTX_NOTE_LEN - 1,"Police only")
		else if(ctx_cuffed(id))
			copy(why,CTX_NOTE_LEN - 1,"You are cuffed")
		else if(!ARP_GetUserItemNum(id,g_ItCuffs))
			copy(why,CTX_NOTE_LEN - 1,"You have no Cuffs")
	}

	if(!why[0] && ARP_IsCop(target))
		copy(why,CTX_NOTE_LEN - 1,"Police cannot be cuffed")

	if(!why[0])
		ctx_reach_why(id,target,RANGE_CUFF,why,CTX_NOTE_LEN - 1)

	// police use nothing; anyone else uses a pair of Cuffs to put them on. Free has a key of its own: SayCuff does the opposite of what he is now, so a choice of Cuff must not
	// run when he has been cuffed since the menu was drawn
	new label[8],note[CTX_NOTE_LEN]
	formatex(label,7,"%s",cuffed ? "Free" : "Cuff")
	if(!cop && !cuffed)
		copy(note,CTX_NOTE_LEN - 1,"uses Cuffs")

	ctx_add(cuffed ? "free" : "cuff",label,why,0,note)
}

// Tie, or Untie when he is tied: ARP_Items' rope. Tying is the item's use (the item stays); freeing is /untie and needs no item
stock ctx_e_rope(id,target)
{
	if(!g_ItRope)
		return

	new why[CTX_NOTE_LEN],theirs = ctx_rope(target),mine = ctx_rope(id)

	if(theirs & ROPE_TIED)
	{
		if(mine & ROPE_TAPED)
			copy(why,CTX_NOTE_LEN - 1,"Your mouth is taped")
		else
			ctx_reach_why(id,target,RANGE_RESTRAINT,why,CTX_NOTE_LEN - 1)

		ctx_add("untie","Untie",why)

		return
	}

	if(!ARP_GetUserItemNum(id,g_ItRope))
		copy(why,CTX_NOTE_LEN - 1,"You have no Rope")
	else if(mine & ROPE_HOLDS)
		copy(why,CTX_NOTE_LEN - 1,"You hold someone already")
	else
		ctx_reach_why(id,target,RANGE_RESTRAINT,why,CTX_NOTE_LEN - 1)

	ctx_add("tie","Tie",why)
}

// Tape mouth (the item, a roll is used up), or Remove tape when his mouth is taped (/removetape, no item)
stock ctx_e_tape(id,target)
{
	if(!g_ItTape)
		return

	new why[CTX_NOTE_LEN],theirs = ctx_rope(target),mine = ctx_rope(id)

	if(theirs & ROPE_TAPED)
	{
		if(mine & ROPE_TAPED)
			copy(why,CTX_NOTE_LEN - 1,"Your mouth is taped")
		else
			ctx_reach_why(id,target,RANGE_RESTRAINT,why,CTX_NOTE_LEN - 1)

		ctx_add("untape","Remove tape",why)

		return
	}

	if(!ARP_GetUserItemNum(id,g_ItTape))
		copy(why,CTX_NOTE_LEN - 1,"You have no Tape")
	else
		ctx_reach_why(id,target,RANGE_RESTRAINT,why,CTX_NOTE_LEN - 1)

	ctx_add("tape","Tape mouth",why,0,"uses a roll")
}

// the amounts a cvar lists, "50 100 250": the positive numbers in it, at most CTX_AMOUNTS, in the order written. Returns how many.
stock ctx_amounts(pcvar,out[])
{
	new text[96],tok[16],n
	get_pcvar_string(pcvar,text,95)

	while(text[0] && n < CTX_AMOUNTS)
	{
		new rest[96]
		strtok(text,tok,15,rest,95,' ')
		trim(tok)
		copy(text,95,rest)
		trim(text)

		new v = ctx_num(tok)
		if(v >= 1)
			out[n++] = v
	}

	return n
}

// what he can pay a fine: his wallet and his bank, as /fine counts it
stock ctx_funds(target)
	return ARP_GetUserBank(target) + ARP_GetUserWallet(target)

// the least of the amounts a page offers: the cvar lists them in the order written, which need not rise
stock ctx_least(const amounts[],n)
{
	new least = amounts[0]
	for(new i = 1;i < n;i++)
		if(amounts[i] < least)
			least = amounts[i]

	return least
}

stock ctx_fine_why(id,target,why[],len)
{
	why[0] = 0
	new amounts[CTX_AMOUNTS],n = ctx_amounts(p_FineAmounts,amounts)

	if(!ARP_IsCop(id))
		copy(why,len,"Police only")
	else if(!n)
		copy(why,len,"No amounts are set")
	else if(ctx_funds(target) < ctx_least(amounts,n))
		copy(why,len,"He has no money")
	else
		ctx_reach_why(id,target,RANGE_MONEY,why,len)
}

stock ctx_give_why(id,target,why[],len)
{
	why[0] = 0
	new amounts[CTX_AMOUNTS],n = ctx_amounts(p_GiveAmounts,amounts)

	if(!n)
		copy(why,len,"No amounts are set")
	else if(is_user_bot(target))
		copy(why,len,"Bots cannot hold money")
	else if(!ARP_PlayerReady(target))
		copy(why,len,"He is not ready")
	else if(ARP_GetUserWallet(id) < ctx_least(amounts,n))
		copy(why,len,"Your wallet is empty")
	else
		ctx_reach_why(id,target,RANGE_MONEY,why,len)
}

stock ctx_e_fine(id,target)
{
	if(!get_pcvar_num(p_Fine))
		return

	new why[CTX_NOTE_LEN]
	ctx_fine_why(id,target,why,CTX_NOTE_LEN - 1)
	ctx_add("fine","Fine",why,CTXF_MORE)
}

stock ctx_e_give(id,target)
{
	if(!get_pcvar_num(p_Give))
		return

	new why[CTX_NOTE_LEN]
	ctx_give_why(id,target,why,CTX_NOTE_LEN - 1)
	ctx_add("give","Give money",why,CTXF_MORE)
}

// whether an item is a license or a card: its name has "license" or "card" in it
stock bool:ctx_is_doc(kind)
{
	new name[33]
	ARP_GetItemName(kind,name,32)

	return containi(name,"license") != -1 || containi(name,"card") != -1
}

// the licenses and cards the player has: their kinds (at most CTX_DOCS_MAX), and how many
stock ctx_docs(id,kinds[])
{
	new n
	for(new k = 1;k <= 255 && ARP_ValidItemId(k) && n < CTX_DOCS_MAX;k++)
		if(ARP_GetUserItemNum(id,k) > 0 && ctx_is_doc(k))
			kinds[n++] = k

	return n
}

stock ctx_e_show(id,target)
{
	if(!ctx_cv("arp_h9_inv_window"))
		return

	new why[CTX_NOTE_LEN],kinds[CTX_DOCS_MAX]

	if(!ctx_docs(id,kinds))
		copy(why,CTX_NOTE_LEN - 1,"No license or card")
	else
		ctx_inv_why(id,target,CTXW_SHOW,why,CTX_NOTE_LEN - 1)

	ctx_add("show","Show license or card",why,CTXF_MORE)
}

// the entries other plugins add: ARP_H9CtxBuild is called in each, and they call ARP_H9CtxAdd
stock ctx_e_extra(id,target)
{
	new fwd = CreateMultiForward("ARP_H9CtxBuild",ET_IGNORE,FP_CELL,FP_CELL)
	if(fwd < 0)
		return

	new ret
	g_Building = 1
	ExecuteForward(fwd,ret,id,target)
	g_Building = 0
	DestroyForward(fwd)
}

// ARP_H9CtxAdd(label, handler, enabled, note): the plugin calling it is `Plugin`
public _ARP_H9CtxAdd(Plugin,Params)
{
	if(!g_Building || Params < 2 || g_BPage != CTXP_MAIN || g_BExtra >= CTX_EXTRA_MAX || g_BN >= CTX_ROWS)
		return 0

	new label[CTX_LABEL_LEN],handler[CTX_HANDLER_LEN],note[CTX_NOTE_LEN]
	get_string(1,label,CTX_LABEL_LEN - 1)
	get_string(2,handler,CTX_HANDLER_LEN - 1)

	new bool:on = true
	if(Params >= 3)
		on = get_param(3) ? true : false

	if(Params >= 4)
		get_string(4,note,CTX_NOTE_LEN - 1)

	if(!label[0] || !handler[0])
		return 0

	// the entry is known by its plugin and its handler and label, so that a menu built again finds the same entry
	new key[CTX_KEY_LEN]
	formatex(key,CTX_KEY_LEN - 1,"x%d.%d",Plugin,ctx_hash(label,ctx_hash(handler,0)))

	// an entry that its plugin lists as not available is greyed with its reason, or with a default one: ctx_add reads "enabled" from there being no reason
	new why[CTX_NOTE_LEN]
	if(!on)
	{
		if(note[0])
			copy(why,CTX_NOTE_LEN - 1,note)
		else
			copy(why,CTX_NOTE_LEN - 1,"Not available now")
	}

	new r = ctx_add(key,label,why,0,on ? note : "")
	if(r < 0)
		return 0

	g_BPlugin[r] = Plugin
	copy(g_BHandler[r],CTX_HANDLER_LEN - 1,handler)
	g_BExtra++

	return 1
}

// the page of amounts: a fine or money. Each amount is a row; the reason the page's own row would be greyed for greys them all, and an amount that is too much is greyed alone.
stock ctx_page_amounts(id,target,page)
{
	new amounts[CTX_AMOUNTS],n,why[CTX_NOTE_LEN],text[24],key[CTX_KEY_LEN]

	if(page == CTXP_FINE)
	{
		copy(g_BTitle,CTX_NAME_LEN,"FINE")
		n = ctx_amounts(p_FineAmounts,amounts)
		ctx_fine_why(id,target,why,CTX_NOTE_LEN - 1)
	}
	else
	{
		copy(g_BTitle,CTX_NAME_LEN,"GIVE MONEY")
		n = ctx_amounts(p_GiveAmounts,amounts)
		ctx_give_why(id,target,why,CTX_NOTE_LEN - 1)
	}

	get_user_name(target,text,23)
	ctx_clean(text,g_BSub,CTX_NAME_LEN)

	for(new i;i < n;i++)
	{
		new row[CTX_NOTE_LEN],money[24]
		copy(row,CTX_NOTE_LEN - 1,why)

		if(!row[0])
		{
			if(page == CTXP_FINE && amounts[i] > ctx_funds(target))
				copy(row,CTX_NOTE_LEN - 1,"He cannot pay")
			else if(page == CTXP_GIVE && amounts[i] > ARP_GetUserWallet(id))
				copy(row,CTX_NOTE_LEN - 1,"You have less")
		}

		ctx_money(id,amounts[i],money,23)
		formatex(key,CTX_KEY_LEN - 1,"%s:%d",page == CTXP_FINE ? "fine" : "give",amounts[i])
		ctx_add(key,money,row)
	}

	ctx_add("back","Back","",CTXF_GAP)
}

// the page of the show: the licenses and cards he has
stock ctx_page_show(id,target)
{
	new kinds[CTX_DOCS_MAX],n = ctx_docs(id,kinds),why[CTX_NOTE_LEN],name[33],key[CTX_KEY_LEN]

	copy(g_BTitle,CTX_NAME_LEN,"SHOW")
	get_user_name(target,name,32)
	ctx_clean(name,g_BSub,CTX_NAME_LEN)

	ctx_inv_why(id,target,CTXW_SHOW,why,CTX_NOTE_LEN - 1)

	for(new i;i < n;i++)
	{
		ARP_GetItemName(kinds[i],name,32)
		formatex(key,CTX_KEY_LEN - 1,"show:%d",kinds[i])
		ctx_add(key,name,why)
	}

	ctx_add("back","Back","",CTXF_GAP)
}

// the menu of a player on a target, a page of it, into the g_B arrays
stock ctx_build(id,target,page)
{
	g_BN = 0
	g_BExtra = 0
	g_BPage = page
	g_BTitle[0] = 0
	g_BSub[0] = 0

	ctx_items()

	switch(page)
	{
		case CTXP_FINE, CTXP_GIVE:
			ctx_page_amounts(id,target,page)
		case CTXP_SHOW:
			ctx_page_show(id,target)
		default:
		{
			new name[CTX_NAME_LEN]
			get_user_name(target,name,CTX_NAME_LEN - 1)
			ctx_clean(name,g_BTitle,CTX_NAME_LEN)

			ctx_e_trade(id,target)
			ctx_e_search(id,target)
			ctx_e_cuff(id,target)
			ctx_e_rope(id,target)
			ctx_e_tape(id,target)
			ctx_e_fine(id,target)
			ctx_e_give(id,target)
			ctx_e_show(id,target)
			ctx_e_extra(id,target)
		}
	}
}

// the row of the page just built that has this key, or -1
stock ctx_find(const key[])
{
	for(new r;r < g_BN;r++)
		if(equal(g_BKey[r],key))
			return r

	return -1
}

// a number that says whether the page just built is the one the player has: its rows' keys, labels, notes and flags
stock ctx_sig()
{
	new h = g_BPage * 31 + g_BN

	h = ctx_hash(g_BTitle,h)
	h = ctx_hash(g_BSub,h)

	for(new r;r < g_BN;r++)
	{
		h = ctx_hash(g_BKey[r],h)
		h = ctx_hash(g_BLabel[r],h)
		h = ctx_hash(g_BNote[r],h)
		h = h * 31 + g_BFlags[r]
	}

	return h
}

// the number key of a row: 1 to 9, 10 for the 0 key, none (0) after that; the Back row of a page of choices is the 0 key
stock ctx_keyno(r)
{
	if(equal(g_BKey[r],"back"))
		return 10

	if(r < 9)
		return r + 1

	return r == 9 ? 10 : 0
}

// ---------------------------------------------------------------------------------------------------------------------- the messages

stock ctx_begin(id)
	engfunc(EngFunc_MessageBegin,MSG_ONE,g_MsgCtx,Float:{0.0,0.0,0.0},id)

// the page just built, to the player: its header and its rows; a refresh keeps the serial, a new menu or a new page has a new one
stock ctx_send(id,bool:refresh)
{
	ctx_begin(id)
	write_byte(CTX_OP_OPEN)
	write_byte(g_Serial[id])
	write_byte(refresh ? 1 : 0)
	write_byte(g_BPage)
	write_byte(g_BN)
	write_string(g_BTitle)
	write_string(g_BSub)
	message_end()

	for(new i;i < g_BN;)
	{
		new size = 4,cnt
		while(i + cnt < g_BN)
		{
			new row = 2 + strlen(g_BLabel[i + cnt]) + 1 + strlen(g_BNote[i + cnt]) + 1
			if(cnt > 0 && size + row > CTX_MSG_MAX)
				break

			size += row
			cnt++
		}

		ctx_begin(id)
		write_byte(CTX_OP_ROWS)
		write_byte(g_Serial[id])
		write_byte(i)
		write_byte(cnt)

		for(new k;k < cnt;k++)
		{
			write_byte(g_BFlags[i + k])
			write_byte(ctx_keyno(i + k))
			write_string(g_BLabel[i + k])
			write_string(g_BNote[i + k])
		}

		message_end()
		i += cnt
	}

	g_Rows[id] = g_BN
	g_Sig[id] = ctx_sig()

	for(new r;r < g_BN;r++)
		copy(g_RowKey[id][r],CTX_KEY_LEN - 1,g_BKey[r])
}

stock ctx_note(id,level,const text[])
{
	if(!g_Serial[id] || !is_user_connected(id) || g_MsgCtx <= 0)
		return

	new clean[CTX_NOTE_LEN + 40]
	ctx_clean(text,clean,sizeof clean)

	ctx_begin(id)
	write_byte(CTX_OP_NOTE)
	write_byte(g_Serial[id])
	write_byte(level)
	write_string(clean)
	message_end()
}

// ---------------------------------------------------------------------------------------------------------------------- the state

// a player's menu is forgotten without a word to him
stock ctx_reset(id)
{
	if(id < 1 || id > MAX_PLAYERS)
		return

	if(g_Serial[id] && g_Up > 0)
		g_Up--

	g_Serial[id] = 0
	g_Target[id] = 0
	g_Page[id] = 0
	g_Rows[id] = 0
	g_Sig[id] = 0
	g_CmdCount[id] = 0
	g_CmdAt[id] = 0.0
}

// a menu that is up is closed, and the player told why
stock ctx_close(id,reason)
{
	if(id < 1 || id > MAX_PLAYERS || !g_Serial[id])
		return

	if(is_user_connected(id) && g_MsgCtx > 0)
	{
		ctx_begin(id)
		write_byte(CTX_OP_CLOSE)
		write_byte(g_Serial[id])
		write_byte(reason)
		message_end()
	}

	ctx_reset(id)
}

// the next serial of a player's menus, 1 to 255; it goes on counting after a menu is closed, so a late command of the last one finds no menu of that number
stock ctx_next_serial(id)
{
	g_Last[id] = g_Last[id] >= 255 ? 1 : g_Last[id] + 1

	return g_Last[id]
}

// whether this player can be shown the menu: a human who is alive with his character loaded, whose game draws it and who wants Apollo RP's panels
stock bool:ctx_wanted(id)
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id) || !is_user_alive(id) || g_MsgCtx <= 0)
		return false

	if(!ARP_PlayerReady(id) || h9vgui_protocol(id) < H9VGUI_CTXMENU_PROTOCOL)
		return false

	return arpvgui_wanted(id)
}

// whether the pair may still have a menu: both alive and here, and near enough. Returns the reason to close it with, or -1.
stock ctx_gone(id,target)
{
	if(!get_pcvar_num(p_On) || !ctx_wanted(id))
		return CTXC_SERVER

	if(ctx_cuffed(id))
		return CTXC_DIED

	if(target < 1 || target > MAX_PLAYERS || !is_user_connected(target) || !is_user_alive(target))
		return CTXC_TARGET

	// arp_h9_ctx_range 0: no limit but each action's own reach
	new Float:range = get_pcvar_float(p_Range)
	if(range > 0.0 && ctx_dist(id,target) > range)
		return CTXC_FAR

	return -1
}

// ARP_Inventory's Player_Use handler asks: the use key was pressed on `target`. Returns 1 when the menu is up for the player now, and 0 when the press is left to
// what it did before (the switch is off, his game cannot draw the menu, the player is not one, or no entry is listed at all)
public H9Ctx_Press(id,target)
{
	ctx_sweep_pin()

	if(!get_pcvar_num(p_On) || !ctx_wanted(id))
		return 0

	// a cuffed player's press is left to the use key's own answer: the menu he would be given is one that ctx_gone closes at the next tick
	if(ctx_cuffed(id))
		return 0

	if(target < 1 || target > MAX_PLAYERS || target == id || !is_user_connected(target) || !is_user_alive(target))
		return 0

	ctx_build(id,target,CTXP_MAIN)
	if(!g_BN)
		return 0

	if(!g_Serial[id])
		g_Up++

	g_Serial[id] = ctx_next_serial(id)
	g_Target[id] = target
	g_Page[id] = CTXP_MAIN
	ctx_send(id,false)

	return 1
}

// every half second: the menus that cannot go on are closed, and one whose rows changed is sent again
public ctx_tick()
{
	ctx_sweep_pin()

	if(g_Up < 1)
		return

	for(new id = 1;id <= MAX_PLAYERS;id++)
	{
		if(!g_Serial[id])
			continue

		new target = g_Target[id],why = ctx_gone(id,target)
		if(why >= 0)
		{
			ctx_close(id,why)

			continue
		}

		ctx_build(id,target,g_Page[id])
		if(!g_BN)
		{
			ctx_close(id,CTXC_SERVER)

			continue
		}

		if(ctx_sig() != g_Sig[id])
			ctx_send(id,true)
	}
}

// ---------------------------------------------------------------------------------------------------------------------- a choice

// an action that works on the player looked at, run as the player's own command with his aim on the target. Returns 1 when it was run.
stock ctx_pinned_call(id,target,const plugin[],const func[],const arg[])
{
	// the text is padded: the handler of a chat command may write into the text it is given, and a pushed string has the room of its own length alone
	new text[100]
	copy(text,99,arg)

	for(new i = strlen(text);i < 99;i++)
		text[i] = ' '

	text[99] = 0

	if(!ctx_pin(id,target))
		return 0

	if(callfunc_begin(func,plugin) != 1)
	{
		ctx_unpin(id)

		return 0
	}

	callfunc_push_int(id)
	callfunc_push_int(0)
	callfunc_push_str(text,false)
	callfunc_end()

	ctx_unpin(id)

	return 1
}

// the choice of a row of the page the player has, checked again: carried out, or refused with a note. Returns 1 when the menu is to close.
stock ctx_run(id,target,r)
{
	new key[CTX_KEY_LEN],cmd[40]
	copy(key,CTX_KEY_LEN - 1,g_BKey[r])

	// the pages of choices open on the same player
	if(equal(key,"back"))
	{
		g_Page[id] = CTXP_MAIN
		g_Serial[id] = ctx_next_serial(id)
		ctx_build(id,target,CTXP_MAIN)
		ctx_send(id,false)

		return 0
	}

	if(equal(key,"fine") || equal(key,"give") || equal(key,"show"))
	{
		new page = equal(key,"fine") ? CTXP_FINE : (equal(key,"give") ? CTXP_GIVE : CTXP_SHOW)

		g_Page[id] = page
		g_Serial[id] = ctx_next_serial(id)
		ctx_build(id,target,page)
		ctx_send(id,false)

		return 0
	}

	// the entries of other plugins
	if(g_BPlugin[r])
	{
		new fwd = CreateOneForward(g_BPlugin[r],g_BHandler[r],FP_CELL,FP_CELL)
		if(fwd < 0)
		{
			ctx_note(id,1,"That is not available now.")

			return 0
		}

		new ret
		ctx_pin(id,target)
		ExecuteForward(fwd,ret,id,target)
		ctx_unpin(id)
		DestroyForward(fwd)

		return 1
	}

	if(equal(key,"trade") || equal(key,"search"))
	{
		if(callfunc_begin("H9Inv_CtxDo","ARP_Inventory.amxx") != 1)
		{
			ctx_note(id,1,"That is not available now.")

			return 0
		}

		callfunc_push_int(id)
		callfunc_push_int(target)
		callfunc_push_int(equal(key,"trade") ? CTXW_TRADE : CTXW_SEARCH)
		callfunc_end()

		return 1
	}

	if(equal(key,"cuff") || equal(key,"free"))
		return ctx_pinned_call(id,target,"ARP_JailMod.amxx","SayCuff","")

	if(equal(key,"untie"))
		return ctx_pinned_call(id,target,"ARP_Items.amxx","CmdSay","/untie")

	if(equal(key,"untape"))
		return ctx_pinned_call(id,target,"ARP_Items.amxx","CmdSay","/removetape")

	// the item's use: the item's own handler asks for the player looked at
	if(equal(key,"tie") || equal(key,"tape"))
	{
		new item = equal(key,"tie") ? g_ItRope : g_ItTape

		if(!ctx_pin(id,target))
			return 0

		new rc = ARP_UserUseItem(id,item)
		ctx_unpin(id)

		if(rc == ARP_ITEM_BUSY)
			ctx_note(id,1,"You are using another item.")
		else if(rc != ARP_ITEM_OK)
			ctx_note(id,1,"You cannot do that now.")

		return 1
	}

	// a fine or money: "fine:100" and "give:50" of the pages of amounts
	if(equal(key,"fine:",5) || equal(key,"give:",5))
	{
		new amount = ctx_num(key[5])
		if(amount < 1)
			return 0

		formatex(cmd,39,"/%s %d",key[0] == 'f' ? "fine" : "givemoney",amount)

		return ctx_pinned_call(id,target,"ARP_Commands.amxx","CmdSay",cmd)
	}

	// a license or a card shown: "show:<kind>"
	if(equal(key,"show:",5))
	{
		new kind = ctx_num(key[5])
		if(kind < 1)
			return 0

		if(callfunc_begin("H9Inv_CtxShow","ARP_Inventory.amxx") != 1)
		{
			ctx_note(id,1,"That is not available now.")

			return 0
		}

		callfunc_push_int(id)
		callfunc_push_int(target)
		callfunc_push_int(kind)
		callfunc_end()

		return 1
	}

	return 0
}

// the choice of the row `index` of the menu with this serial, from the client command (or a test). Anything that does not fit the menu he has is dropped.
stock ctx_pick(id,serial,index)
{
	if(!g_Serial[id] || serial != g_Serial[id] || index < 0 || index >= g_Rows[id])
		return

	new key[CTX_KEY_LEN],target = g_Target[id],why = ctx_gone(id,target)
	copy(key,CTX_KEY_LEN - 1,g_RowKey[id][index])

	if(why >= 0)
	{
		ctx_close(id,why)

		return
	}

	// the menu again, from the rules as they are now: the entry must still be in it, and enabled
	ctx_build(id,target,g_Page[id])

	new r = ctx_find(key)
	if(r < 0)
	{
		ctx_note(id,1,"That is not available now.")
		ctx_send(id,true)

		return
	}

	if(!(g_BFlags[r] & CTXF_ON))
	{
		ctx_note(id,1,g_BNote[r])
		if(ctx_sig() != g_Sig[id])
			ctx_send(id,true)

		return
	}

	if(ctx_run(id,target,r))
		ctx_close(id,CTXC_DONE)
}

// ---------------------------------------------------------------------------------------------------------------------- the client command

public CmdH9Ctx(id)
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || is_user_bot(id))
		return PLUGIN_HANDLED

	ctx_sweep_pin()

	// ten commands a second; the rest are dropped without a word
	new Float:now = get_gametime()
	if(now - g_CmdAt[id] >= 1.0 || now < g_CmdAt[id])
	{
		g_CmdAt[id] = now
		g_CmdCount[id] = 0
	}

	if(++g_CmdCount[id] > 10)
		return PLUGIN_HANDLED

	new line[64],arg[24]
	for(new i = 1;i < read_argc() && i < 4;i++)
	{
		read_argv(i,arg,23)

		if(i > 1)
			add(line,63," ")

		add(line,63,arg)
	}

	CtxLine(id,line)

	return PLUGIN_HANDLED
}

// h9ctx <op> <args>, as the client sends it (and as a test sends it for a player who has no client). Every argument is checked here. Returns 1 when it was understood.
public CtxLine(id,const Line[])
{
	if(id < 1 || id > MAX_PLAYERS || !is_user_connected(id) || !g_Serial[id])
		return 0

	new op[12],a1[12],a2[12]
	parse(Line,op,11,a1,11,a2,11)

	new serial = ctx_num(a1)

	if(equal(op,"close"))
	{
		if(serial == g_Serial[id] || serial == 0)
			ctx_reset(id)

		return 1
	}

	if(equal(op,"pick"))
	{
		new index = ctx_num(a2)
		if(serial < 0 || index < 0)
			return 0

		ctx_pick(id,serial,index)

		return 1
	}

	return 0
}

// ---------------------------------------------------------------------------------------------------------------------- the console

// a player by his number (1 to the slots) or a part of his name
stock ctx_target(const arg[])
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

// arp_h9_ctx_dump <user> [<target>]: the menu the user has up, or the first page of the one the use key on the target would give him (nothing is sent)
public CmdDump(id,level,cid)
{
	if(!ARP_CmdAccess(id,cid,2))
		return PLUGIN_HANDLED

	new arg[33],user,target,page
	read_argv(1,arg,32)
	user = ctx_target(arg)

	if(!user)
	{
		console_print(id,"[ARP] There is no such player.")

		return PLUGIN_HANDLED
	}

	read_argv(2,arg,32)
	if(arg[0])
	{
		target = ctx_target(arg)
		if(!target)
		{
			console_print(id,"[ARP] There is no such player.")

			return PLUGIN_HANDLED
		}
	}
	else if(g_Serial[user])
	{
		target = g_Target[user]
		page = g_Page[user]
	}

	console_print(id,"CTX user=%d on=%d level=%d wanted=%d up=%d serial=%d target=%d page=%d range=%d",user,get_pcvar_num(p_On),h9vgui_protocol(user),ctx_wanted(user) ? 1 : 0,g_Serial[user] ? 1 : 0,g_Serial[user],g_Serial[user] ? g_Target[user] : 0,g_Page[user],get_pcvar_num(p_Range))

	if(!target)
		return PLUGIN_HANDLED

	ctx_build(user,target,page)

	for(new r;r < g_BN;r++)
		console_print(id,"ROW %d key=%s flags=%d keyno=%d label=^"%s^" note=^"%s^"",r,g_BKey[r],g_BFlags[r],ctx_keyno(r),g_BLabel[r],g_BNote[r])

	console_print(id,"ROWS n=%d sig=%d title=^"%s^" sub=^"%s^"",g_BN,ctx_sig(),g_BTitle,g_BSub)

	return PLUGIN_HANDLED
}
