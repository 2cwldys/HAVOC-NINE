#if defined _ApolloRP_Chat_included
	#endinput
#endif

#define _ApolloRP_Chat_included

#include <ApolloRP>

#pragma library "arp_chat"

native ARP_AddChat(const param[] = "",const handler[])

native ARP_AddTeamChat(const param[] = "",const handler[])

// H9: gag != 0 keeps what a player says aloud from being heard (the voice talk area of ARP_TalkArea, arp_voice 1); 0 lets him be heard again. Taped mouths use it.
native ARP_H9Gag(id,gag)

stock ARP_RegisterChat(const param[] = "",const handler[],const description[])
{
	new Command[128]
	format(Command,127,"say %s",param)
	if(param[0])
		ARP_AddCommand(Command,description)

	ARP_AddChat(param,handler)
}

stock ARP_RegisterTeamChat(const param[] = "",const handler[],const description[])
{
	new Command[128]
	format(Command,127,"say_team %s",param)
	if(param[0])
		ARP_AddCommand(Command,description)

	ARP_AddTeamChat(param,handler)
}

stock ARP_EscapeString(string[],len)
	replace_all(string,len,"%","%%")

stock ARP_ChatMessage(from,to,const msg[])
{
	// This could be done in an if statement but I might want to expand it later
	switch(get_cvar_num("arp_colorchat"))
	{
		case 0 : 
			ARP_StdChat(from,to,msg)
		case 1 :
			ARP_ColorChat(from,to,msg)
		default :
			return FAILED
	}

	return SUCCEEDED
}

stock ARP_ColorChat(from,to,const msg[])
{
	new message[256]
	copy(message[1],251,msg)

	message[0] = ''
	message[strlen(message)] = '^n'
	message[strlen(message)] = '^0'

	ARP_StdChat(from,to,message)
}	

stock ARP_StdChat(from,to,const msg[])
{		
	if(!to)
	{		
		new Players[MAX_PLAYERS],Playersnum
		get_players(Players,Playersnum)
		
		for(new Count;Count < Playersnum;Count++)
			_ARP_SendChat(from,Players[Count],msg)
	}
	else _ARP_SendChat(from,to,msg)
}

// This is an internal function and should not be used
stock _ARP_SendChat(from,to,const message[])
{
	static Data[256]
	Data[0] = from
	Data[1] = to
	copy(Data[2],sizeof Data - 3,message)

	if(ARP_CallEvent("Chat_Message",Data,255))
		return FAILED	

	if(message[0] == '')
	{
		message_begin(MSG_ONE_UNRELIABLE,get_user_msgid("SayText"),_,to)
		write_byte(to)
		write_string(message)
		message_end()
	}
	// H9: what players type is not Apollo RP's to change: no credit sign (ApolloRP_Credits.inc)
	else arp_print_plain(to,print_chat,message)
	
	return SUCCEEDED
}