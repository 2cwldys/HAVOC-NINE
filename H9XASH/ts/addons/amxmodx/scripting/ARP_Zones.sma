#include <amxmodx>
#include <amxmisc>
#include <ApolloRP>
#include <fakemeta>
#include <engine>
#include <HamSandwich>
#include <ApolloRP_Chat>
#include <xs>
#include <ApolloRP_H9Cfg>

new gZone[MAX_PLAYERS + 1][33]

new TravTrie:gZones

new p_H9ZoneFix
new g_H9ZoneFix

public ARP_Init()
{
	ARP_RegisterPlugin( "Zones", "1.0", "Hawk552", "Handles zones on the map" )
	
	ARP_RegisterEvent( "HUD_Render", "EventHUDRender" )
	
	set_task( 0.1, "RegisterZone" )	
}

public EventHUDRender( const name[], const data[], len )
{	
	new id = data[0]
	if ( !is_user_alive( id ) || !ARP_PlayerReady( id ) || ARP_SqlHandle() == Empty_Handle || data[1] != HUD_PRIM )
		return
	
	ARP_AddHudItem( id, HUD_PRIM, 0, "Location: %s", gZone[id][0] ? gZone[id] : "Unknown" )
}

public RegisterZone()
	ARP_RegisterEvent( "Player_Zone", "EventPlayerZone" )

public plugin_natives()
{
	register_native( "ARP_GetUserZone", "_ARP_GetUserZone" )
	
	register_library( "arp_zone" )
}

public plugin_init()
{
	register_event( "DeathMsg", "EventDeathMsg", "a" )
	
	register_touch( "trigger_multiple", "player", "EventTouch" )

	// H9: arp_h9_zonefix 1 repairs two faults of the stock plugin: a zones.ini of several zones is read to its end (the corners below), and a player's touch of a trigger_multiple reaches the game
	// (EventTouch). 0 is stock Apollo RP's plugin. The zones are read here, before the server has executed arp.cfg, so for them the switch is the line arp.cfg holds (h9_cfg_num; with no
	// line, 1); the touch follows the cvar.
	p_H9ZoneFix = register_cvar( "arp_h9_zonefix", "1" )
	g_H9ZoneFix = h9_cfg_num( "arp_h9_zonefix", 1 )
	
#if 0
	new ent, targetname[33]
	while ( ( ent = find_ent_by_class( ent, "trigger_multiple" ) ) )
	{
		pev( ent, pev_targetname, targetname, 32 )
		server_print( "target: %s", targetname )
	}
#endif

	gZones = TravTrieCreate()

	new file = ARP_FileOpen( "zones.ini", "r" )
	if ( !file )
	{
		log_amx( "Error opening file: zones.ini" )
		return
	}
	
	new buffer[128], TravTrie:current, left[33], right[33], originPieces[3][11], originStr[33], Float:boundaries1[3], Float:boundaries2[3], name[33]
	while ( !feof( file ) )
	{
		fgets( file, buffer, charsmax( buffer ) )
		replace( buffer, charsmax( buffer ), "^n", "" )
		
		if ( !buffer[0] || buffer[0] == ';' ) 
			continue
		
		if ( buffer[0] == '{' )
		{
			current = TravTrieCreate()
			//log_amx("Creating travtrie: %d",Reading)
			continue
		}
		else if ( buffer[0] == '}' )
		{
			TravTrieSetCell( gZones, name, current )
			
			TravTrieGetString( current, "boundaries1", originStr, charsmax( originStr ) )
			parse( originStr, originPieces[0], 10, originPieces[1], 10, originPieces[2], 10 )
			boundaries1[0] = str_to_float( originPieces[0] )
			boundaries1[1] = str_to_float( originPieces[1] )
			boundaries1[2] = str_to_float( originPieces[2] )
			
			TravTrieGetString( current, "boundaries2", originStr, charsmax( originStr ) )
			parse( originStr, originPieces[0], 10, originPieces[1], 10, originPieces[2], 10 )
			boundaries2[0] = str_to_float( originPieces[0] )
			boundaries2[1] = str_to_float( originPieces[1] )
			boundaries2[2] = str_to_float( originPieces[2] )
			
			// If they're in the wrong order.
			if ( boundaries1[0] > boundaries2[0] || boundaries1[1] > boundaries2[1] || boundaries1[2] > boundaries2[2] )
			{
				if ( boundaries1[0] > boundaries2[0] )
					swap( boundaries1[0], boundaries2[0] )
				if ( boundaries1[1] > boundaries2[1] )
					swap( boundaries1[1], boundaries2[1] )
				if ( boundaries1[2] > boundaries2[2] )
					swap( boundaries1[2], boundaries2[2] )
			}
			
			// If they're too close (i.e. basically on the same z plane).
			if ( boundaries2[2] - boundaries1[2] < 32.0 )
			{
				boundaries2[2] += 16.0
				boundaries1[2] -= 16.0
			}
			
			// H9: a corner is written back as the whole numbers it was read as. TravTrieSetString looks an old value up first, with TravTrieGetString into a buffer of 4 cells and the length 4, and
			// AMX Mod X writes the end of such a string one cell past the length it is given, over the wrapper's saved frame pointer: the plugin stops with a memory access error as it next uses a
			// local, at the end of the first zone, so a file of several zones gives one. The key is there already (it was set when the line was read), so with arp_h9_zonefix 1 TrieSetString puts
			// the same value in the same place; 0 calls the wrapper as stock does.
			formatex( originStr, charsmax( originStr ), "%d %d %d", floatround( boundaries1[0] ), floatround( boundaries1[1] ), floatround( boundaries1[2] ) )
			if ( g_H9ZoneFix )
				TrieSetString( Trie:current, "boundaries1", originStr )
			else
				TravTrieSetString( current, "boundaries1", originStr )
			
			formatex( originStr, charsmax( originStr ), "%d %d %d", floatround( boundaries2[0] ), floatround( boundaries2[1] ), floatround( boundaries2[2] ) )
			if ( g_H9ZoneFix )
				TrieSetString( Trie:current, "boundaries2", originStr )
			else
				TravTrieSetString( current, "boundaries2", originStr )
			
			current = Invalid_TravTrie
			
			continue
		}
		
		if ( current != Invalid_TravTrie )
		{						
			parse( buffer, left, charsmax( left ), right, charsmax( right ) )
			trim( left )
			remove_quotes( left )
			trim( right )
			remove_quotes( right )
			
			if ( !buffer[0] || buffer[0] == ';' || strlen( buffer ) < 5 ) 
				continue
			
			TravTrieSetString( current, left, right )
		}
		else
		{
			copy( name, charsmax( name ), buffer )
			trim( name )
			remove_quotes( name )
		}
	}
	
	fclose( file )
}

public client_PreThink( id )
{	
	if ( !is_user_connected( id ) )
		return
	
	static Float:lastOrigin[MAX_PLAYERS + 1][3], Float:lastCheck[MAX_PLAYERS + 1]
	new Float:newOrigin[3], Float:curTime = get_gametime()
	
	pev( id, pev_origin, newOrigin )
	if ( curTime - lastCheck[id] < 1.0 || xs_vec_nearlyequal( lastOrigin[id], newOrigin ) )
		return
	
	lastCheck[id] = curTime
	lastOrigin[id] = newOrigin
	
	new travTrieIter:iter = GetTravTrieIterator( gZones ), TravTrie:current, Float:boundaries1[3], Float:boundaries2[3]
	while ( MoreTravTrie( iter ) )
	{
		static originStr[33], originPieces[3][11], name[33]
		
		ReadTravTrieKey( iter, name, charsmax( name ) )
		ReadTravTrieCell( iter, current )
		
		if ( equali( name, gZone[id] ) )
			continue
		
		TravTrieGetString( current, "boundaries1", originStr, charsmax( originStr ) )
		parse( originStr, originPieces[0], 10, originPieces[1], 10, originPieces[2], 10 )
		boundaries1[0] = str_to_float( originPieces[0] )
		boundaries1[1] = str_to_float( originPieces[1] )
		boundaries1[2] = str_to_float( originPieces[2] )
		
		TravTrieGetString( current, "boundaries2", originStr, charsmax( originStr ) )
		parse( originStr, originPieces[0], 10, originPieces[1], 10, originPieces[2], 10 )
		boundaries2[0] = str_to_float( originPieces[0] )
		boundaries2[1] = str_to_float( originPieces[1] )
		boundaries2[2] = str_to_float( originPieces[2] )
		
		if ( newOrigin[0] > boundaries1[0] && newOrigin[1] > boundaries1[1] && newOrigin[2] > boundaries1[2]
		  && newOrigin[0] < boundaries2[0] && newOrigin[1] < boundaries2[1] && newOrigin[2] < boundaries2[2] )
		{
			CallZoneEvent( id, name )
			break
		}
	}
	DestroyTravTrieIterator( iter )
}

public EventTouch( ptr, ptd )
{
	static targetName[33]
	pev( ptr, pev_targetname, targetName, 32 )
	if ( strlen( targetName ) && !equali( targetName, gZone[ptd] ) )
		CallZoneEvent( ptd, targetName )
	
	// H9: a touch handler's return value blocks the touch from 1 up: PLUGIN_CONTINUE lets it reach the game, the stock FMRES_IGNORED (1) blocks it
	return get_pcvar_num( p_H9ZoneFix ) ? PLUGIN_CONTINUE : FMRES_IGNORED
}

public _ARP_GetUserZone( plugin, params )
{
	if ( params != 3 )
	{
		new text[64]
		formatex( text, charsmax( text ), "Parameters do not match. Expected: 3, Found: %d", params )
		return log_amx( text )
	}
	
	new id = get_param( 1 )
	
	if ( !is_user_connected( id ) )
	{
		new file[33]
		//get_plugin( -1, file, 32, "", 0, "", 0, "", 0, "", 0 )
		
		new text[64]
		formatex( text, charsmax( text ), "User not connected: %d ( %d : %s )", id, plugin, file )
		return log_error( AMX_ERR_NATIVE, text )
	}
	
	set_string( 2, gZone[id], get_param( 3 ) )
	
	return SUCCEEDED
}

public EventPlayerZone( const name[], const data[], len )
{
	new id = data[0]
	
	copy( gZone[id], 32, data[1] )
	
	if ( is_user_connected( id ) )
		ARP_RefreshHud( id, HUD_PRIM )
}

public client_connect( id )
	CallZoneEvent( id, "" )

CallZoneEvent( id, const zone[] )
{	
	new data[64]
	data[0] = id
	copy( data[1], charsmax( data ) - 1, zone )
	ARP_CallEvent( "Player_Zone", data, 64 )
}

public EventDeathMsg()
	CallZoneEvent( read_data( 2 ), "" )

swap( &any:a, &any:b )
{
	static temp
	temp = a
	a = b
	b = temp
}