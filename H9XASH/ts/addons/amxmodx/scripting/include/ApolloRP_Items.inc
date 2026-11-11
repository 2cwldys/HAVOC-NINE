#if defined _ApolloRP_Items_included
	#endinput
#endif

#define _ApolloRP_Items_included

#include <ApolloRP>

// This will register an item that can be used in game.
// This MUST be run during ARP_RegisterItems and no other time.
// Returns FAILED (0) on failure, or an item id on success
// name[] - name of item, ex. "Lamp Shade"
// handler[] - function to call when it is used
// description - what the item is like, i.e. "Tastes like chicken."
// remove - whether or not the item should be taken away once used, if it is
// disposable
native ARP_RegisterItem(name[],handler[],description[],remove = 0)

// Will find an item based on search string, with the same method as FindJobId.
native ARP_FindItemId(searchstring[],results[],maxresults)

// Determines whether an item id is valid or not
native ARP_ValidItemId(itemid)

// Will get an item's name based on an item id.
// itemid - id of the item
// name - where to store the name
// len - length of name
native ARP_GetItemName(itemid,name[],len)

// Gets user item num
native ARP_GetUserItemNum(id,itemid)

// Sets user item id to whatever value
native ARP_SetUserItemNum(id,itemid,num)

// Forces a user to use an item.
// Note that they must possess at least 1 of the item with the specified
// itemid.
// Setting useup to 1 makes it such that it will both check if the user has the item,
// and that if it's disposable is on, it gets used up
// Setting it to 0 both ignores whether or not the user has the item, as well as
// the disposable setting
native ARP_ForceUseItem(id,itemid,useup = 1)

// Sets their item to done so that they can start using other items again
native ARP_ItemDone(id)

// Artificially tells the core that the user is using an item.
// To end this, use ARP_ItemDone.
native ARP_ItemSet(id)

// H9: the item menu's own paths, which the inventory window (ARP_Inventory) runs too. Each returns 0 (ARP_ITEM_OK: it was done) or the
// reason it was not. The Item_Use, Item_Give and Item_Drop events fire as they do for the text menu, and an item's own plugin says why when
// it takes one. None prints a refusal: the caller words it (the item menu's own code prints what it always did).
#define ARP_ITEM_OK       0
#define ARP_ITEM_NONE     1   // the player has none of it, or not that many
#define ARP_ITEM_BUSY     2   // he is using another item (ARP_ItemSet)
#define ARP_ITEM_VETOED   3   // an Item_ event handler took it
#define ARP_ITEM_INVALID  4   // not an item, a count below 1, or not a player
#define ARP_ITEM_FULL     5   // give: the other player's inventory has no room for all of it
#define ARP_ITEM_NOPACK   6   // drop: no pack can be made (arp_performance 10 or less, or no entity left)

// Uses one of the player's items, as choosing Use in the item menu does
native ARP_UserUseItem(id,itemid)

// Gives num of the player's item to another player, all of it or none: the other player's inventory must have room for it all
native ARP_UserGiveItem(id,target,itemid,num)

// Shows the player's item to another player, as choosing Show in the item menu does: the Item_Show event, then the chat lines; nothing changes hands
native ARP_UserShowItem(id,target,itemid)

// Drops num of the player's item as a pack on the floor at his feet; the items leave him once the pack exists
native ARP_UserDropItem(id,itemid,num)

// Makes a pack of num of an item on the floor at the player's feet without taking anything from him; returns the entity, or 0
native ARP_DropPack(id,itemid,num)

// An item's name, its description and whether using it uses it up (the remove flag of ARP_RegisterItem)
native ARP_GetItemInfo(itemid,name[],namelen,desc[],desclen,&disposable)

// How many of qty of an item the player's inventory has room for: all of it when no inventory is loaded or its cells are not limited
native ARP_InvRoom(id,itemid,qty)

// Saves the player's character (wallet, bank, job, items) now; returns 0 when his character is not loaded
native ARP_SaveUser(id)

// The inventory's hooks. ARP_Inventory implements them when it is loaded; a core with nothing to answer them is stock Apollo RP.
//   ARP_InvOnCount: a count of a player's items is about to become newnum (from oldnum): returns the count to keep, plus one (0: no opinion).
//   ARP_InvOnRoom:  how many of qty fit, plus one.
//   ARP_InvOnUse:   an item's use begins (begin 1) and ends (0): its handler runs between the two, and the item is used up before the end.
//   ARP_InvOnNote:  a line for the player about his items; returns 1 when it has shown it (the core prints it as chat when it has not).
forward ARP_InvOnCount(id,itemid,oldnum,newnum)
forward ARP_InvOnRoom(id,itemid,qty)
forward ARP_InvOnUse(id,itemid,begin)
forward ARP_InvOnNote(id,level,const text[])

// called when you can register items
forward ARP_RegisterItems()

stock ARP_FindItem(searchstring[])
{
	new Results[1]
	ARP_FindItemId(searchstring,Results,1)
	
	return ARP_ValidItemId(Results[0]) ? Results[0] : FAILED
}

stock ARP_GiveUserItem(id,itemid,num)
{
	if(!is_user_connected(id) || !ARP_ValidItemId(itemid)) return FAILED
	
	return ARP_SetUserItemNum(id,itemid,max(ARP_GetUserItemNum(id,itemid) + num,0))
}

stock ARP_TakeUserItem(id,itemid,num)
{
	if(!is_user_connected(id) || !ARP_ValidItemId(itemid)) return FAILED
	
	new CurrentAmount = ARP_GetUserItemNum(id,itemid)
	if(CurrentAmount < num) return FAILED
	
	return ARP_SetUserItemNum(id,itemid,max(CurrentAmount - num,0))
}