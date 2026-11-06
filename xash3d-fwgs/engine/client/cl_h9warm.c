/*
cl_h9warm.c - H9: the browser build fetches what a join reads before it reads it
Copyright (C) 2026 HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

A game file in the browser build comes over the network the first time the engine reads it, and the engine waits
for it in the middle of whatever reads it (havoc9.org\webclient\client.js, lazyFile). A join reads hundreds of
files in one call, CL_PrecacheResources ("inside one frame", cl_h9join.c): 499 files and 269 MB on 2026-11-04.
Each of them held the page still, with no frame drawn, no sound mixed and no key read, for as long as all of
them took together.

Here the page is given those files as soon as the server's resource list is in. It fetches them in parallel
without holding anything (Module.warm in client.js: want, state, done, total, kb, cancel), the join screen says
how far it is, and the precache runs when they are all there and finds them in memory:

  CL_H9Warm_Ready  asked before CL_PrecacheResources, by CL_ParseResourceList and by CL_ProcessFile: true when
                   there is nothing to wait for (a page without Module.warm, or no file missing), false while the
                   page fetches. The frame of the panel this file registers goes on with the join, the call the
                   two places would have made, once the page says it is done, or after H9W_PATIENCE.

The native build has no use for it: CL_H9Warm_Ready is true there.
*/

#include "common.h"
#include "client.h"
#include "net_ws.h"
#include "cl_motd.h"
#if XASH_EMSCRIPTEN
#include <emscripten.h>
#endif

#if XASH_EMSCRIPTEN

#define H9W_LIST     ( 96 * 1024 ) // the most characters of the list of files handed to the page
#define H9W_PATIENCE 900.0         // seconds the page may take: then the join goes on and reads what is not here

static struct
{
	qboolean waiting;    // the page is fetching for a precache that has not run
	qboolean panel;      // the frame's panel is registered
	double   began;      // host.realtime the page was handed the list
	int      files;      // what it was handed
} h9w;

// the page, Module.warm: want( list ) starts the fetches, a file's name on each line of the list; state() is 0 while
// it fetches and 1 when it is done; done(), total() and kb() count the files and the kilobytes fetched; cancel()
// drops what has not started. A page without Module.warm answers state() -1.
EM_JS( void, H9W_PageWant, ( const char *list ), {
	var warm = Module.warm;
	if( warm && warm.want )
		warm.want( UTF8ToString( list ));
});

EM_JS( int, H9W_PageState, ( void ), {
	var warm = Module.warm;
	try {
		return warm && warm.state ? warm.state() : -1;
	} catch( e ) {
		return -1;
	}
});

EM_JS( int, H9W_PageCount, ( int which ), {
	var warm = Module.warm;
	try {
		return which == 0 ? warm.done() : which == 1 ? warm.total() : warm.kb();
	} catch( e ) {
		return 0;
	}
});

EM_JS( void, H9W_PageCancel, ( void ), {
	var warm = Module.warm;
	if( warm && warm.cancel )
		warm.cancel();
});

// the files CL_PrecacheResources will read and nothing has loaded yet, a name on each line; how many
static int H9W_List( char *out, size_t size )
{
	resource_t *p;
	size_t used = 0;
	int count = 0;

	out[0] = '\0';
	for( p = cl.resourcesonhand.pNext; p && p != &cl.resourcesonhand; p = p->pNext )
	{
		const char *prefix = "";
		size_t need;

		if( FBitSet( p->ucFlags, RES_PRECACHED ) || FBitSet( p->ucFlags, RES_WASMISSING ))
			continue;

		switch( p->type )
		{
		case t_model:
			if( p->szFileName[0] == '*' )
				continue; // a part of the world's own file
			break;
		case t_sound:
			prefix = DEFAULT_SOUNDPATH;
			break;
		case t_generic:
		case t_eventscript:
			break;
		default:
			continue;
		}

		need = Q_strlen( prefix ) + Q_strlen( p->szFileName ) + 1;
		if( used + need + 1 >= size )
			break; // the rest is read as it always was
		used += Q_snprintf( out + used, size - used, "%s%s\n", prefix, p->szFileName );
		count++;
	}
	return count;
}

static void H9W_SetCvar( const char *name, const char *value )
{
	convar_t *cv = Cvar_FindVar( name );

	if( cv && Q_strcmp( cv->string, value ))
		Cvar_DirectFullSet( cv, value, 0 );
}

// the join screen's file line and bars, the ones a download uses (cl_h9join.c reads them)
static void H9W_Screen( int done, int total, int kb )
{
	char line[96];
	float bar = 15.0f + ( total > 0 ? 35.0f * done / total : 0.0f );

	Q_snprintf( line, sizeof( line ), "game files   %d of %d   %d MB", done, Q_max( total, 1 ), kb / 1024 );
	H9W_SetCvar( "_h9join_stage", "Downloading" );
	H9W_SetCvar( "_h9join_file", line );
	H9W_SetCvar( "_h9join_fileprog", va( "%d", total > 0 ? 100 * done / total : 0 ));
	if( bar > Cvar_VariableValue( "scr_loading" ))
		Cvar_SetValue( "scr_loading", bar );
}

// what CL_ParseResourceList and CL_ProcessFile do when the precache is ready to run, now that the files are here
static void H9W_Resume( void )
{
	byte msg_buf[MAX_INIT_MSG];
	sizebuf_t msg;

	MSG_Init( &msg, "Resource Registration", msg_buf, sizeof( msg_buf ));

	if( CL_PrecacheResources( ))
		CL_RegisterResources( &msg, cls.net_protocol );

	if( MSG_GetNumBytesWritten( &msg ) > 0 )
	{
		Netchan_CreateFragments( &cls.netchan, &msg );
		Netchan_FragSend( &cls.netchan );
	}
}

static void H9W_Frame( void )
{
	int state;

	if( !h9w.waiting )
		return;

	if( cls.state == ca_disconnected )
	{
		h9w.waiting = false;
		H9W_PageCancel();
		return;
	}

	state = H9W_PageState();
	if( state == 0 && host.realtime - h9w.began < H9W_PATIENCE )
	{
		H9W_Screen( H9W_PageCount( 0 ), H9W_PageCount( 1 ), H9W_PageCount( 2 ));
		return;
	}

	if( state == 0 )
	{
		Con_Printf( S_ERROR "H9 WARM: the page did not finish in %d seconds; the join reads the rest itself\n", (int)H9W_PATIENCE );
		H9W_PageCancel();
	}
	else Con_Printf( "H9 WARM: %d files, %d MB here after %.1f seconds\n", H9W_PageCount( 1 ), H9W_PageCount( 2 ) / 1024, host.realtime - h9w.began );

	h9w.waiting = false;
	H9W_Resume();
}

static qboolean H9W_NotUp( void ) { return false; }
static qboolean H9W_NoKey( int key, qboolean down ) { (void)key; (void)down; return false; }
static void H9W_NoDraw( void ) { }

// a new map or server, or a disconnect: what the page still fetches is not wanted
static void H9W_Reset( qboolean connection )
{
	(void)connection;
	if( h9w.waiting )
	{
		h9w.waiting = false;
		H9W_PageCancel();
	}
}

// never up itself: its Frame follows the page's fetching
static const h9ui_panel_t h9w_panel =
{
	H9W_NotUp,
	H9W_NoKey,
	H9W_NoKey,
	H9W_Frame,
	H9W_NoDraw,
	H9W_Reset,
};

#endif // XASH_EMSCRIPTEN

/*
==============
CL_H9Warm_Ready
==============
*/
qboolean CL_H9Warm_Ready( void )
{
#if XASH_EMSCRIPTEN
	static char list[H9W_LIST];

	if( h9w.waiting )
		return false;
	if( H9W_PageState() < 0 )
		return true;

	h9w.files = H9W_List( list, sizeof( list ));
	if( !h9w.files )
		return true;

	if( !h9w.panel )
	{
		H9UI_AddPanel( &h9w_panel );
		h9w.panel = true;
	}

	h9w.waiting = true;
	h9w.began = host.realtime;
	Con_Printf( "H9 WARM: the page fetches %d files before the precache\n", h9w.files );
	H9W_PageWant( list );
	H9W_Screen( 0, h9w.files, 0 );
	return false;
#else
	return true;
#endif
}
