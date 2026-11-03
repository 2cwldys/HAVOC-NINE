/*
cl_h9join.c - H9: the join screen, the menu's connection progress while a server is joined
Copyright (C) 2026 HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

GoldSrc shows a loading bar while it joins a server, with each file it downloads; upstream Xash shows
its console instead (CL_Connect_f's "TESTTEST" lines). With a menu that has the connection progress
hooks (menu_int.h's UI_EXTENDED_FUNCTIONS: H9's mainui, menus/ConnectionProgress.cpp as
mainui-h9-joinscreen.patch makes it), the menu stays up from the moment a join starts (connect, retry,
the local server's own client) and at each map change (svc_changing, reconnect) until the player is in
the game (ca_active): its background, or its video, full screen, and a panel with the stage, an overall
bar (scr_loading) and, while a file downloads, its name, n of N and its own bar with KB of KB, over H9's
HTTP fast download or the netchan. ESC on it cancels the join. A join or a game the server or the engine
ends with a reason (refused, kicked, timed out, a file that could not come) shows it, with OK.

What the menu reads, set by this file, read-only, and private (FCVAR_PRIVILEGED: no server reads or sets
them):
  _h9join           1 while the screen is up
  _h9join_stage     what happens: Connecting, Server info, Downloading, Loading the map, Precaching
                    resources, Spawning, Changing level
  _h9join_server    the server it joins (its address; the local server says so)
  _h9join_file      the file downloading, "<name>   n of N   a of b KB"; empty without a download
  _h9join_fileprog  that file's bar, 0 to 100
  _h9_drop          why the last join or game ended, when the server or the engine said; empty for a cancel
                    or a plain disconnect
scr_loading, the overall bar: connecting 5 and a little more for each try, server info 15, the downloads
up to 50 by the bytes still to come, the map 55, the other resources up to 90 by their count, spawning 95.
The precache runs inside one frame, so it draws a frame now and then (SCR_UpdateScreen, H9J_PUMP).

None of it runs for a demo or a timedemo, on a background map, with cl_h9_joinscreen 0, or with a menu
without the hooks: upstream's console comes up there, as before, and a game that ends says nothing more
than upstream says. (Upstream called these hooks once and
took them back, d2a8cfe6, "breaks demo playback": the menu stayed up over demos. A demo never begins a
join here, and the server data keeps the menu up only for a join this file began.)
*/

#include "common.h"
#include "client.h"
#include "net_ws.h"
#include "cl_motd.h"

#define H9J_PUMP 0.15 // seconds between two frames the precache draws
#define H9J_REASON_AGE 15.0 // seconds a reason waits for the disconnect it explains

static CVAR_DEFINE_AUTO( cl_h9_joinscreen, "1", FCVAR_ARCHIVE|FCVAR_PRIVILEGED, "H9: the menu's join screen while a server is joined (0: the console, as upstream)" );
static CVAR_DEFINE( h9join_up, "_h9join", "0", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: 1 while the join screen is up (set by the engine)" );
static CVAR_DEFINE( h9join_stage, "_h9join_stage", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the join screen's stage (set by the engine)" );
static CVAR_DEFINE( h9join_server, "_h9join_server", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the server the join screen joins (set by the engine)" );
static CVAR_DEFINE( h9join_file, "_h9join_file", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the file the join screen downloads (set by the engine)" );
static CVAR_DEFINE( h9join_fileprog, "_h9join_fileprog", "0", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: that file's progress, 0 to 100 (set by the engine)" );
static CVAR_DEFINE( h9_drop, "_h9_drop", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: why the last join or game ended (set by the engine)" );

static struct
{
	qboolean up;          // the screen is up, for a join or a map change this file began
	int      files;       // the downloads this join counted when they began (n of N), 0 before
	int      precached;   // resources precached so far, of
	int      to_precache;
	double   pumped;      // when the precache last drew a frame
	char     reason[256]; // why the join or the game ends, "" for none
	double   reason_at;   // host.realtime it was said: a reason older than H9J_REASON_AGE explains nothing
} h9j;

static void H9J_Set( convar_t *cv, const char *value )
{
	if( Q_strcmp( cv->string, value ))
		Cvar_DirectFullSet( cv, value, 0 );
}

// the overall bar only grows during a join
static void H9J_Stage( const char *stage, float loading )
{
	H9J_Set( &h9join_stage, stage );
	if( loading > Cvar_VariableValue( "scr_loading" ))
		Cvar_SetValue( "scr_loading", loading );
}

static qboolean H9J_MenuHasIt( void )
{
	return gameui.hInstance && gameui.dllFuncs2.pfnConnectionProgress_Connect && gameui.dllFuncs2.pfnConnectionProgress_Disconnect
		&& gameui.dllFuncs2.pfnConnectionProgress_ChangeLevel;
}

static qboolean H9J_Usable( void )
{
	return cl_h9_joinscreen.value && H9J_MenuHasIt() && !cls.demoplayback && !cls.timedemo && host.type == HOST_NORMAL;
}

// the screen up for a join or a map change: the menu in front, the console out of the way
static void H9J_Raise( const char *server, const char *stage, float loading )
{
	h9j.up = true;
	h9j.files = 0;
	h9j.precached = h9j.to_precache = 0;
	h9j.reason[0] = '\0';
	H9J_Set( &h9_drop, "" );
	H9J_Set( &h9join_server, server );
	H9J_Set( &h9join_file, "" );
	H9J_Set( &h9join_fileprog, "0" );
	Cvar_SetValue( "scr_loading", 0.0f );
	H9J_Stage( stage, loading );
	H9J_Set( &h9join_up, "1" );
	if( cls.key_dest == key_console )
		Con_FastClose();
	// a join from the server browser keeps the browser under the screen, to come back to
	if( UI_IsVisible( ))
		Key_SetKeyDest( key_menu );
	else UI_SetActiveMenu( true );
}

static void H9J_Lower( void )
{
	h9j.up = false;
	H9J_Set( &h9join_up, "0" );
	H9J_Set( &h9join_stage, "" );
	H9J_Set( &h9join_file, "" );
	H9J_Set( &h9join_fileprog, "0" );
}

/*
==============
CL_H9Join_Begin

CL_Connect_f, CL_Retry_f, and the local server's own client (server NULL): true when the screen is up,
false for upstream's console
==============
*/
qboolean CL_H9Join_Begin( const char *server )
{
	if( !H9J_Usable( ))
		return false;
	if( !server )
	{
		// this game's own server: its background map has no join, and its map change has the screen up
		if( sv_background.value )
			return false;
		if( h9j.up )
			return true;
	}
	H9J_Raise( server ? server : "this game's own server", server ? "Connecting" : "Starting the server", 5.0f );
	gameui.dllFuncs2.pfnConnectionProgress_Connect( server );
	return true;
}

// another try at a server that has not answered yet
void CL_H9Join_Try( int retry )
{
	char stage[64];

	if( !h9j.up )
		return;
	Q_snprintf( stage, sizeof( stage ), retry > 1 ? "Connecting (try %d)" : "Connecting", retry );
	H9J_Stage( stage, Q_min( 5.0f + retry, 12.0f ));
}

/*
==============
CL_H9Join_ChangeLevel

svc_changing, or the server's reconnect (once its own disconnect is done, when it has one): the screen up
until the next map's game is in; a background map's change keeps the menu as upstream has it
==============
*/
void CL_H9Join_ChangeLevel( void )
{
	if( !H9J_Usable( ) || h9j.up || cls.state == ca_disconnected || cl.background || ( SV_Active( ) && sv_background.value ))
		return;
	H9J_Raise( cls.servername, "Changing level", 5.0f );
	gameui.dllFuncs2.pfnConnectionProgress_ChangeLevel( );
}

/*
==============
CL_H9Join_ServerInfo

svc_serverdata: true when the screen keeps the menu up (CL_ParseServerData leaves it be); a background
map ends it, and the menu goes as upstream has it go
==============
*/
qboolean CL_H9Join_ServerInfo( void )
{
	if( !h9j.up )
		return false;
	if( cl.background || cls.demoplayback )
	{
		H9J_Lower();
		return false;
	}
	H9J_Stage( "Server info", 15.0f );
	return true;
}

// a frame drawn now and then while the precache, inside one frame, runs
static void H9J_Pump( qboolean now )
{
	const double t = Platform_DoubleTime();

	if( !now && t - h9j.pumped < H9J_PUMP )
		return;
	h9j.pumped = t;
	SCR_UpdateScreen();
}

/*
==============
CL_H9Join_PrecacheStart, _PrecacheWorld, _PrecacheStep

CL_PrecacheResources: the resources it has still to load, the world (the map) first, then each other one
==============
*/
void CL_H9Join_PrecacheStart( void )
{
	resource_t *p;

	if( !h9j.up )
		return;
	h9j.precached = h9j.to_precache = 0;
	for( p = cl.resourcesonhand.pNext; p && p != &cl.resourcesonhand; p = p->pNext )
	{
		if( !FBitSet( p->ucFlags, RES_PRECACHED ))
			h9j.to_precache++;
	}
	H9J_Set( &h9join_file, "" );
}

void CL_H9Join_PrecacheWorld( void )
{
	if( !h9j.up )
		return;
	H9J_Stage( "Loading the map", 55.0f );
	H9J_Pump( true );
}

void CL_H9Join_PrecacheStep( void )
{
	if( !h9j.up )
		return;
	h9j.precached++;
	H9J_Stage( "Precaching resources", 55.0f + 35.0f * h9j.precached / Q_max( h9j.to_precache, 1 ));
	H9J_Pump( false );
}

// CL_RegisterResources: everything is loaded, the server spawns the player
void CL_H9Join_Spawning( void )
{
	if( !h9j.up )
		return;
	H9J_Stage( "Spawning", 95.0f );
}

/*
==============
CL_H9Join_End

ca_active: the player is in the game; the menu goes, and the game's own screens (client.dll's team and
class menus among them) come up over the game as they always do
==============
*/
void CL_H9Join_End( void )
{
	if( !h9j.up )
		return;
	H9J_Lower();
	Cvar_SetValue( "scr_loading", 0.0f );
	UI_SetActiveMenu( false );
}

/*
==============
CL_H9Join_Drop

why the join or the game ends, when it ends soon after: CL_Disconnect hands it to the menu. Color codes
(^n) and the line ends of the server's text are cleaned out; a reason with nothing left keeps the one
said before it.
==============
*/
void CL_H9Join_Drop( const char *reason )
{
	char clean[sizeof( h9j.reason )];
	size_t n = 0;
	const char *p;

	if( !reason )
		return;
	for( p = reason; *p && n + 1 < sizeof( clean ); p++ )
	{
		if( *p == '^' && p[1] >= '0' && p[1] <= '9' )
		{
			p++;
			continue;
		}
		if( *p == '\n' || *p == '\r' )
		{
			if( n && clean[n - 1] != ' ' )
				clean[n++] = ' ';
			continue;
		}
		clean[n++] = *p;
	}
	while( n && clean[n - 1] == ' ' )
		n--;
	if( !n )
		return;
	clean[n] = '\0';
	Q_strncpy( h9j.reason, clean, sizeof( h9j.reason ));
	h9j.reason_at = host.realtime;
}

/*
==============
CL_H9Join_Disconnect

CL_Disconnect: a join this file began ends before the game, or any game ends with a reason; the menu
goes back to its own screens and says the reason, with OK
==============
*/
void CL_H9Join_Disconnect( void )
{
	const qboolean was_up = h9j.up;

	if( was_up )
		H9J_Lower();
	H9J_Set( &h9_drop, h9j.reason[0] && host.realtime - h9j.reason_at < H9J_REASON_AGE ? h9j.reason : "" );
	h9j.reason[0] = '\0';
	if( !H9J_MenuHasIt( ) || cls.demoplayback )
		return;
	// a game (no join screen up) that ends says why only with the join screen on, and only with a reason
	if( !was_up && ( !h9_drop.string[0] || !cl_h9_joinscreen.value ))
		return;
	if( !UI_IsVisible( ))
		UI_SetActiveMenu( true );
	gameui.dllFuncs2.pfnConnectionProgress_Disconnect( );
}

// the frame's look at the downloads (the H9UI registry's Frame): the file, n of N, its KB and its bar
static void H9J_Frame( void )
{
	char name[MAX_SYSPATH], line[MAX_SYSPATH + 64];
	int got = 0, size = -1, remaining, n;
	float file_pct = -1.0f;

	if( !h9j.up )
		return;

	remaining = host.downloadcount;
	if( remaining <= 0 && ( scr_download.value < 0.0f ))
	{
		if( h9join_file.string[0] )
			H9J_Set( &h9join_file, "" );
		return;
	}

	name[0] = '\0';
#if !XASH_EMSCRIPTEN
	if( HTTP_FileProgress( name, sizeof( name ), &got, &size ) && size > 0 )
		file_pct = 100.0f * got / size;
#endif
	if( !name[0] )
	{
		// over the netchan: the file the fragments carry, its size from the resource list
		resource_t *p;

		Q_strncpy( name, host.downloadfile, sizeof( name ));
		if( scr_download.value >= 0.0f )
			file_pct = scr_download.value;
		for( p = cl.resourcesneeded.pNext; name[0] && p && p != &cl.resourcesneeded; p = p->pNext )
		{
			if( Q_strstr( name, p->szFileName ) && p->nDownloadSize > 0 )
			{
				size = p->nDownloadSize;
				got = file_pct >= 0.0f ? (int)( size * file_pct / 100.0f ) : 0;
				break;
			}
		}
	}

	if( remaining > h9j.files )
		h9j.files = remaining;
	n = h9j.files - remaining + 1;
	if( n < 1 )
		n = 1;
	if( n > h9j.files )
		n = h9j.files;

	if( size > 0 )
		Q_snprintf( line, sizeof( line ), "%s   %d of %d   %d of %d KB", name[0] ? COM_FileWithoutPath( name ) : "...", n, Q_max( h9j.files, 1 ), got / 1024, size / 1024 );
	else Q_snprintf( line, sizeof( line ), "%s   %d of %d", name[0] ? COM_FileWithoutPath( name ) : "...", n, Q_max( h9j.files, 1 ));
	H9J_Set( &h9join_file, line );
	Q_snprintf( name, sizeof( name ), "%d", file_pct >= 0.0f ? (int)file_pct : 0 );
	H9J_Set( &h9join_fileprog, name );

	// the overall bar: 15 to 50 by the bytes still to come
	if( cls.dl.nTotalToTransfer > 0 )
		H9J_Stage( "Downloading", 15.0f + 35.0f * ( cls.dl.nTotalToTransfer - Q_max( cls.dl.nRemainingToTransfer, 0 )) / cls.dl.nTotalToTransfer );
	else H9J_Stage( "Downloading", 15.0f );
}

static qboolean H9J_NotUp( void ) { return false; }
static qboolean H9J_NoKey( int key, qboolean down ) { (void)key; (void)down; return false; }
static void H9J_NoDraw( void ) { }
static void H9J_NoReset( qboolean connection ) { (void)connection; }

// never up itself: its Frame follows the downloads while the menu shows the screen
static const h9ui_panel_t h9j_panel =
{
	H9J_NotUp,
	H9J_NoKey,
	H9J_NoKey,
	H9J_Frame,
	H9J_NoDraw,
	H9J_NoReset,
};

/*
==============
CL_H9Join_Up

whether the join screen is up (CL_ErrorMsg leaves its message to it)
==============
*/
qboolean CL_H9Join_Up( void )
{
	return h9j.up;
}

/*
==============
CL_H9Join_Init
==============
*/
void CL_H9Join_Init( void )
{
	Cvar_RegisterVariable( &cl_h9_joinscreen );
	Cvar_RegisterVariable( &h9join_up );
	Cvar_RegisterVariable( &h9join_stage );
	Cvar_RegisterVariable( &h9join_server );
	Cvar_RegisterVariable( &h9join_file );
	Cvar_RegisterVariable( &h9join_fileprog );
	Cvar_RegisterVariable( &h9_drop );
	H9UI_AddPanel( &h9j_panel );
}
