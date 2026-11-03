/*
cl_h9listen.c - H9: presence for a game's own listen server (Create Game; docs/H9_PRESENCE.txt, section 8a)
Copyright (C) 2026 HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

The player who starts a listen server (Create Game) joins it over "loopback", which has no address.
h9_clientid (cl_main.c) is salted with the address a client joins, and the ID proof (cl_idproof.c)
signs that address, so on its own listen server a player had neither an h9_clientid h9web knows nor
a proof. h9_presence on a listen server tells its own player the address it reports as:

  h9_idlisten <a.b.c.d:port>            from now on this connection's h9_clientid is salted with
                                        that address, as a player joining it from elsewhere has it,
                                        and the server is told at once (setinfo)
  h9_idlisten <a.b.c.d:port> <nonce>    the same, then the ID proof's answer with S = that address,
                                        "h9_idproof <nonce> <devmask> <proof>" as cl_idproof.c sends

Only a loopback connection is answered, never a demo: a server elsewhere can never choose the address
a player's h9_clientid is salted with or the proof signs. The address is written back in its one
form (no leading zeros), the form h9web keys servers by. The userinfo key _h9idl is "1" in a game
that answers h9_idlisten, which is what makes a listen server's h9_presence (1.4) use it in place of
h9_idchallenge (a key starting with "_" is not sent to other players).

The hashing is cl_idproof.c's own, built into this file a second time (its H9_IDPROOF_SELFTEST part),
and the device id is read from the same device_id.ini, which cl_idproof.c makes. An answer goes at
most four times a minute. The browser build has none of this: its players are vouched for by h9web's
relay.
*/

#include "common.h"
#include "client.h"
#include "net_ws.h"

#if !XASH_EMSCRIPTEN

#define H9_IDPROOF_SELFTEST
#include "cl_idproof.c"
#undef H9_IDPROOF_SELFTEST

static CVAR_DEFINE( cl_h9idl, "_h9idl", "0", FCVAR_USERINFO|FCVAR_PRIVILEGED, "H9: 1 in a game that answers its own listen server's h9_idlisten (set by the engine, cl_h9listen.c)" );

static uint8_t h9l_device[16];
static qboolean h9l_device_ok;
static double h9l_answered[4]; // when the last four answers went, a ring
static int h9l_next;

// device_id.ini in the root folder, as cl_idproof.c keeps it; read on first need, so a first run,
// which makes the file after this file's init, finds it too
static qboolean H9L_Device( void )
{
	char root[MAX_SYSPATH], path[MAX_SYSPATH], text[512];
	const char *id;
	FILE *f;
	size_t n;
	int i;

	if( h9l_device_ok )
		return true;
	if( !g_fsapi.GetRootDirectory( root, sizeof( root )))
		return false;
	Q_snprintf( path, sizeof( path ), "%s/device_id.ini", root );

	f = fopen( path, "rb" );
	if( !f )
		return false;
	n = fread( text, 1, sizeof( text ) - 1, f );
	fclose( f );
	text[n] = 0;
	id = Q_strstr( text, "id=" );
	if( !id )
		return false;
	id += 3;
	for( i = 0; i < 16; i++ )
	{
		int hi = H9_HexValue( id[i * 2] ), lo = H9_HexValue( id[i * 2 + 1] );

		if( hi < 0 || lo < 0 )
			return false;
		h9l_device[i] = (uint8_t)( hi * 16 + lo );
	}
	h9l_device_ok = true;
	return true;
}

// "a.b.c.d:port", digits only, each part in range; out is the same address in its one form
static qboolean H9L_Address( const char *s, char *out, size_t size )
{
	int part[5] = { 0 }, digits = 0, n = 0;
	const char *p;

	for( p = s; ; p++ )
	{
		if( *p >= '0' && *p <= '9' )
		{
			if( ++digits > 5 )
				return false;
			part[n] = part[n] * 10 + ( *p - '0' );
			continue;
		}
		if( !digits )
			return false;
		if(( n < 3 && *p == '.' ) || ( n == 3 && *p == ':' ))
		{
			n++;
			digits = 0;
			continue;
		}
		if( n == 4 && *p == 0 )
			break;
		return false;
	}

	for( n = 0; n < 4; n++ )
	{
		if( part[n] > 255 )
			return false;
	}
	if( part[4] < 1 || part[4] > 65535 )
		return false;

	Q_snprintf( out, size, "%d.%d.%d.%d:%d", part[0], part[1], part[2], part[3], part[4] );
	return true;
}

/*
==============
CL_H9IdListen_f

h9_idlisten <address> [<nonce>], from this game's own listen server
==============
*/
static void CL_H9IdListen_f( void )
{
	char server[64], h9key[64], devmask[33], proof[65];
	netadr_t adr;
	int i, recent = 0;

	if( Cmd_Argc() < 2 || Cmd_Argc() > 3 || cls.state < ca_connected || cls.demoplayback )
		return;
	if( NET_NetadrType( &cls.netchan.remote_address ) != NA_LOOPBACK )
		return;
	if( !H9_IsHex( cl_h9_userid.string, 32 ) || !H9L_Address( Cmd_Argv( 1 ), server, sizeof( server )))
		return;
	if( !NET_StringToAdr( server, &adr ) || NET_NetadrType( &adr ) != NA_IP )
		return;

	// the h9_clientid a player joining this server from elsewhere has, sent to the server when it changed
	ID_GetMD5ForAddressEx( h9key, adr, sizeof( h9key ), cl_h9_userid.string );
	if( Q_strcmp( Info_ValueForKey( cls.userinfo, "h9_clientid" ), h9key ))
	{
		Info_SetValueForKey( cls.userinfo, "h9_clientid", h9key, sizeof( cls.userinfo ));
		CL_UpdateInfo( "h9_clientid", h9key );
	}

	if( Cmd_Argc() != 3 )
		return;
	if( !H9_IsHex( Cmd_Argv( 2 ), 32 ) || !H9L_Device( ))
		return;

	for( i = 0; i < 4; i++ )
	{
		if( h9l_answered[i] > 0.0 && host.realtime - h9l_answered[i] < 60.0 )
			recent++;
	}
	if( recent >= 4 )
		return;

	H9_IdProof( cl_h9_userid.string, h9l_device, Cmd_Argv( 2 ), server, devmask, proof );
	CL_ServerCommand( true, "h9_idproof %s %s %s", Cmd_Argv( 2 ), devmask, proof );
	h9l_answered[h9l_next] = host.realtime;
	h9l_next = ( h9l_next + 1 ) % 4;
}

/*
==============
CL_H9Listen_Init
==============
*/
void CL_H9Listen_Init( void )
{
	Cvar_RegisterVariable( &cl_h9idl );
	Cmd_AddCommand( "h9_idlisten", CL_H9IdListen_f, "H9: this game's own listen server's address, for its h9_clientid and ID proof (docs/H9_PRESENCE.txt)" );
	Cvar_DirectSet( &cl_h9idl, "1" );
}

#else // XASH_EMSCRIPTEN

void CL_H9Listen_Init( void )
{
}

#endif // XASH_EMSCRIPTEN
