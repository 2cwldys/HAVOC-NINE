#if defined _ApolloRP_Player_included
	#endinput
#endif

#define _ApolloRP_Player_included

#include <ApolloRP>

// Checks whether or not the player's account is loaded
native ARP_PlayerReady(id)

// H9: gets the key of a user's character: the authid his rows (wallet, bank, job, items, keys, properties) are kept under.
// It is the engine's authid, except for a player whose havoc9.org account h9_presence has proved and who made his
// character under an earlier authid (the address of his server changed): then it is that one. Use it, not
// get_user_authid, for anything kept by player. Until the character is loaded it is the engine's authid.
native ARP_GetUserKey(id,key[],len)

// Gets time to payday in ARP units (2 seconds = 1 second, or something like that)
native ARP_GetPayday()

// Gets how hungry the person is (1-100)
native ARP_GetUserHunger(id)

// Sets how hungry the person is (1-100)
native ARP_SetUserHunger(id,hunger)

// Sets the amount of money in someone's wallet
native ARP_SetUserWallet(id,cash)

// Gets the amount of money in someone's wallet
native ARP_GetUserWallet(id)

// Sets the amount of money in someone's bank account
native ARP_SetUserBank(id,cash)

// Gets the amount of money in someone's bank account
native ARP_GetUserBank(id)

// Gets a user's access (personal AND job access [but not job rights])
native ARP_GetUserAccess(id)

// Sets a user's access.
// NOTE: This does NOT allow them to keep their old flags - to do this,
// you should use ARP_SetUserAccess(id,myflags|ARP_GetUserAccess(id))
native ARP_SetUserAccess(id,access)

// called when a user's salary comes
// return PLUGIN_HANDLED to block
forward ARP_Salary(id)
