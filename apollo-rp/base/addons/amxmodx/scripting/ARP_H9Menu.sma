#include <amxmodx>
#include <amxmisc>
#include <ApolloRP>

// H9: the entries of ARP's client menu (arp_menu, say /menu). The core builds that menu from what plugins add to it while it is
// displayed (ARP_AddMenuItem, the Menu_Display event), and no plugin of this set added one, so it opened empty. These are the
// things a player looks for there; each is a command the player could type, and the entry runs it.

public ARP_Error(const Reason[])
	pause("d")

public ARP_Init()
{
	ARP_RegisterPlugin("H9 Menu",ARP_VERSION,"H9","Adds H9's entries to the ARP client menu")

	ARP_RegisterEvent("Menu_Display","EventMenuDisplay")
}

public EventMenuDisplay(Name[],Data[],Len)
{
	new id = Data[0]

	ARP_AddMenuItem(id,"Inventory","MenuInventory")
	ARP_AddMenuItem(id,"My money and job","MenuAccount")
	ARP_AddMenuItem(id,"Jobs on this map","MenuJobs")
	ARP_AddMenuItem(id,"Commands","MenuCommands")

	// a handler's return value is the event's veto: a non-zero one stops the core showing the menu it has just been given
	return PLUGIN_CONTINUE
}

public MenuInventory(id)
	client_cmd(id,"say /items")

public MenuJobs(id)
	client_cmd(id,"arp_joblist")

public MenuCommands(id)
	client_cmd(id,"arp_help")

public MenuAccount(id)
{
	if(!ARP_PlayerReady(id))
	{
		client_print(id,print_chat,"[ARP] Your account is still loading.")
		return
	}

	client_print(id,print_chat,"[ARP] Wallet: $%d  Bank: $%d",ARP_GetUserWallet(id),ARP_GetUserBank(id))

	new JobId = ARP_GetUserJobId(id)
	if(ARP_ValidJobId(JobId))
	{
		new JobName[33]
		ARP_GetJobName(JobId,JobName,32)
		client_print(id,print_chat,"[ARP] Job: %s  Salary: $%d/hr  Payday in %d minutes",JobName,ARP_GetJobSalary(JobId),ARP_GetPayday())
	}
	else
		client_print(id,print_chat,"[ARP] Job: none on this map")
}
