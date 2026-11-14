#include <amxmodx>
#include <amxmisc>
#include <ApolloRP>

new p_HudTitle
new p_Hostname
new p_Credits  // H9: arp_h9_credits, which ARP_Inventory registers: 1 words the wallet line Credits, 0 is stock ARP's Wallet

public ARP_Error(const Reason[])
	pause("d")

public ARP_Init()
{
	ARP_RegisterPlugin("HUD",ARP_VERSION,"The Apollo RP Team","Displays basic HUD information")
	
	p_HudTitle = register_cvar("arp_hud_title","« #hostname# »")
	p_Hostname = get_cvar_pointer("hostname")
	
	ARP_RegisterEvent("HUD_Render","EventHudRender")
}

public EventHudRender(Name[],Data[],Len)
{
	if(Data[1] != HUD_PRIM)
		return
	
	new id = Data[0]
	
	static Temp[64],Title[256],Hostname[128]
	
	get_pcvar_string(p_HudTitle,Title,255)
	get_pcvar_string(p_Hostname,Hostname,127)
			
	replace_all(Title,255,"#hostname#",Hostname)
	replace_all(Title,255,"\n","^n")
	
	ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_TITLE,Title)
	ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_TITLE," ")
	
	if(ARP_SqlHandle() == Empty_Handle)
	{
		ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_STATUS,"SERVER MALFUNCTIONING:")
		ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_STATUS,"Your account will not be saved.")
	}
	else if(!is_user_alive(id)) ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_STATUS,"You are currently dead/spectating...")
	else if(!ARP_PlayerReady(id)) ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_STATUS,"Please wait while your account is loaded...")
	else
	{
		new JobID = ARP_GetUserJobId(id)
		
		if(!p_Credits)
				p_Credits = get_cvar_pointer("arp_h9_credits")

			if(p_Credits && get_pcvar_num(p_Credits))
				ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_WALLET,"Credits: $%d",ARP_GetUserWallet(id))
			else
				ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_WALLET,"Wallet: $%d",ARP_GetUserWallet(id))
		ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_BANK,"Bank: $%d",ARP_GetUserBank(id))
		
		if(ARP_ValidJobId(JobID))
		{
			ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_PAYDAY,"Payday: %dm",ARP_GetPayday())
			ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_SALARY,"Salary: $%d/hr",ARP_GetJobSalary(JobID))
			ARP_GetJobName(JobID,Temp,63)
			ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_JOB,"Job: %s",Temp)
		}
		else
			ARP_AddHudItemKind(id,HUD_PRIM,0,HUDK_JOB,"Job: INVALID (contact admin)")
	}
}
