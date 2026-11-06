/*
cl_presence.c - Discord Rich Presence, sent by the engine itself

The card is built from what the client already has. The status reply of the server it
is connected to gives the map, the player count and the bot count, and the server's
serverinfo carries the mode and its progress, which the plugin publishes as tsm_pres_mode,
tsm_pres_prog and tsm_pres_siege. A server without them is named by its map.
The card goes to the local Discord desktop client over its IPC pipe, the channel every
Rich Presence library uses, so nothing runs beside the game.

The card is on by default. ts_richpresence 0 turns it off, in config.cfg or
userconfig.cfg. Discord shows the name of the application that owns
ts_richpresence_clientid, so that application is registered as HAVOC 9 in the Discord
developer portal. docs\RICH_PRESENCE.txt has the portal steps.

Windows only. Everywhere else the functions return at once.
*/

#include "common.h"
#include "client.h"
#include <time.h>

#define H9P_CLIENT_ID		"1562656412834734181"	// the HAVOC 9 Discord application ID
#define H9P_SMALL_KEY		"h9helmet"	// the small image asset, uploaded to that application
#define H9P_MENU_KEY		"h9_menu"	// the large image on the main-menu card, uploaded to that application
#define H9P_INTERVAL		15.0	// seconds between status queries
#define H9P_RETRY		30.0	// seconds between attempts to reach Discord
#define H9P_SEND_GAP		16.0	// seconds between card updates, to stay under Discord's presence rate limit
#define H9P_CARD_MAX		1024	// longest JSON message sent to Discord
#define H9P_SIDE1_NAME		"MSR"			// side 1 on the card, blue in the game
#define H9P_SIDE2_NAME		"Insurgents"	// side 2 on the card, red in the game
#define H9P_BUTTON1_LABEL	"Join the Discord"	// the first button under the card
#define H9P_BUTTON1_URL		"https://discord.gg/b76pqqVsNY"	// where that button goes
#define H9P_BUTTON2_LABEL	"havoc9.org"		// the second button under the card
#define H9P_BUTTON2_URL		"https://havoc9.org"		// where that button goes

const char *H9_Release( void );   // common/h9_release.c: the release of this game folder

CVAR_DEFINE_AUTO( ts_richpresence, "1", FCVAR_ARCHIVE, "show your game on Discord (Rich Presence): 1 = on, 0 = off" );
static CVAR_DEFINE( h9_rel, "_h9rel", "", FCVAR_USERINFO|FCVAR_READ_ONLY|FCVAR_PRIVILEGED, "H9: the release of this game, sent to every server (h9_release.txt)" );
CVAR_DEFINE_AUTO( ts_richpresence_clientid, H9P_CLIENT_ID, 0, "Discord application ID for the card (set by the build)" );

static struct
{
	qboolean	valid;			// the status reply is from the server we are on
	qboolean	shown;			// a card is up on Discord
	qboolean	warned;			// the missing application ID has been reported
	qboolean	onmenu;			// the card up on Discord is the main-menu card, not a server card
	double		queried;		// realtime of the last status query
	double		retry;			// realtime before the next attempt to reach Discord
	double		sendat;			// realtime before the next card update may go to Discord
	int		start;			// unix time the card first went up, for Discord's elapsed clock
	int		nonce;			// counts the messages sent
	int		players, bots, maxplayers;
	char		map[64];
	char		sent[H9P_CARD_MAX];	// the card last sent, so an unchanged card is not resent
} h9p;

/*
=================
The modes' names

h9p_keys is what an H9 server says it runs (its tsm_pres_mode), h9p_maps what a map's name says. The card's details line (H9P_Mode)
and the server browser's Mode column (CL_H9_ServerMode, CL_H9_StampServerMode) both name a mode from these, so the two always agree.
They are built into every build, the browser's among them: only the pipe to Discord is Windows only.
=================
*/
static const struct { const char *key, *name; } h9p_keys[] =
{
	{ "siege",       "Siege" },
	{ "uplink",      "Capture the Uplink" },
	{ "survival",    "Wave Survival" },
	{ "mechwarrior", "Mech Warrior" },
	{ "assault",     "Assault" },
	{ "ctf",         "Capture the Flag" },
};

static const struct { const char *prefix, *name; } h9p_maps[] =
{
	{ "h9_te_",    "Team Elimination" },
	{ "h9_siege_", "Siege" },
	{ "h9_up_",    "Capture the Uplink" },
	{ "h9_mw_",    "Mech Warrior" },
	{ "h9_ws_",    "Wave Survival" },
	{ "h9_as_",    "Assault" },
	{ "h9_dm_",    "Deathmatch" },
	{ "h9_tdm_",   "Team Deathmatch" },
	{ "h9_ctb_",   "Capture the Briefcase" },
	{ "h9_ctf_",   "Capture the Flag" },
};

/*
=================
CL_H9_ModeName

The name of the mode a server plays, in order:

  1. what an H9 server says it runs, in tsm_pres_mode: "siege", "uplink", "survival",
     "mechwarrior", "assault" or "ctf" (the siege progress in tsm_pres_siege says siege as
     well, from a plugin older than tsm_pres_mode);
  2. the map's name: an h9_<mode>_ map plays that mode, a name starting rp_ or tsrp_, or
     holding _rp_ or _tsrp_ anywhere, is a roleplay map, and one starting ctb_ or ctf_, or
     holding _ctb_ or _ctf_ anywhere, is TS's own capture game (its flag is the briefcase,
     so the two play alike and the name only says which the card shows);
  3. "match" from an H9 server on any other map is Match Mode;
  4. anything else is not named here: NULL.

"match" only says the match mode runs, so the map's name comes before it: an h9_te_ map is
Team Elimination.
=================
*/
const char *CL_H9_ModeName( const char *map, const char *key, const char *siege )
{
	char	name[64];
	size_t	i;

	if( siege[0] )
		return "Siege";

	for( i = 0; i < ARRAYSIZE( h9p_keys ); i++ )
	{
		if( !Q_stricmp( key, h9p_keys[i].key ))
			return h9p_keys[i].name;
	}

	Q_strnlwr( map, name, sizeof( name ));
	for( i = 0; i < ARRAYSIZE( h9p_maps ); i++ )
	{
		if( !Q_strncmp( name, h9p_maps[i].prefix, Q_strlen( h9p_maps[i].prefix )))
			return h9p_maps[i].name;
	}

	if( !Q_strncmp( name, "rp_", 3 ) || !Q_strncmp( name, "tsrp_", 5 )
		|| Q_strstr( name, "_rp_" ) || Q_strstr( name, "_tsrp_" ))
		return "Roleplay";

	if( !Q_strncmp( name, "ctb_", 4 ) || Q_strstr( name, "_ctb_" ))
		return "Capture the Briefcase";

	if( !Q_strncmp( name, "ctf_", 4 ) || Q_strstr( name, "_ctf_" ))
		return "Capture the Flag";

	if( !Q_stricmp( key, "match" ))
		return "Match Mode";

	return NULL;
}

/*
=================
CL_H9_KeyFromDescription

The mode key behind a server's game description, as ts_matchmode and the mode plugins set it
(tsm_gamedesc "Match Mode", tsm_gamedesc_siege "Siege" or "Siege 2/5", and the modes' own
names); "" when the description is not one of H9's. The rule of keyFromDescription() in
h9web's modules/presence/modes.js.
=================
*/
static const char *CL_H9_KeyFromDescription( const char *desc )
{
	size_t	i;

	if( !Q_stricmp( desc, "match mode" ))
		return "match";

	if( !Q_strnicmp( desc, "siege", 5 ) && ( desc[5] == '\0' || desc[5] == ' ' ))
		return "siege";

	for( i = 0; i < ARRAYSIZE( h9p_keys ); i++ )
	{
		if( !Q_stricmp( desc, h9p_keys[i].name ))
			return h9p_keys[i].key;
	}

	return "";
}

/*
=================
CL_H9_ServerMode

The server browser's word for a server's mode, from its map and its game description (the one
in a GoldSrc A2S reply, or the "desc" an H9 server's own info reply carries): the names of
CL_H9_ModeName, and Deathmatch, or Team Deathmatch on a teamplay server, for a server nothing
else says more of.
=================
*/
const char *CL_H9_ServerMode( const char *map, const char *desc, qboolean teamplay )
{
	const char	*name = CL_H9_ModeName( map, CL_H9_KeyFromDescription( desc ), "" );

	if( name )
		return name;

	return teamplay ? "Team Deathmatch" : "Deathmatch";
}

/*
=================
CL_H9_StampServerMode

Puts the "mode" key into an Xash server's info reply before the browser gets it, named from
its "map", "desc" and "team". A reply that fills its buffer has no room for it, and the browser
then shows no mode for that server.
=================
*/
void CL_H9_StampServerMode( char *info, size_t size )
{
	char		map[64], desc[40];
	const char	*name;

	Q_strncpy( map, Info_ValueForKey( info, "map" ), sizeof( map ));
	Q_strncpy( desc, Info_ValueForKey( info, "desc" ), sizeof( desc ));
	name = CL_H9_ServerMode( map, desc, Q_atoi( Info_ValueForKey( info, "team" )) != 0 );

	if( Q_strlen( info ) + Q_strlen( name ) + 8 >= size )
		return;

	Info_SetValueForKey( info, "mode", name, size );
}

#if XASH_WIN32
/*
=================
H9P_Escape

Escapes text for a JSON string. Control characters become spaces.
=================
*/
static void H9P_Escape( char *dst, size_t size, const char *src )
{
	size_t	i = 0;

	for( ; *src && i + 2 < size; src++ )
	{
		if( *src == '"' || *src == '\\' )
		{
			dst[i++] = '\\';
			dst[i++] = *src;
		}
		else if(( unsigned char )*src < ' ' )
		{
			dst[i++] = ' ';
		}
		else
		{
			dst[i++] = *src;
		}
	}

	dst[i] = '\0';
}
#endif

#if XASH_WIN32
static HANDLE	h9p_pipe = INVALID_HANDLE_VALUE;

/*
=================
H9P_Close

Closes the pipe. Discord drops the card when its end of the pipe goes.
=================
*/
static void H9P_Close( void )
{
	if( h9p_pipe != INVALID_HANDLE_VALUE )
		CloseHandle( h9p_pipe );

	h9p_pipe = INVALID_HANDLE_VALUE;
	h9p.shown = false;
	h9p.sent[0] = '\0';
}

/*
=================
H9P_Write

Sends one Discord IPC frame: an opcode and a length, both little-endian 32-bit
numbers, then the JSON text.
=================
*/
static qboolean H9P_Write( int opcode, const char *json )
{
	unsigned char	head[8];
	unsigned int	uop = ( unsigned int )opcode;
	unsigned int	ulen = ( unsigned int )Q_strlen( json );
	DWORD		written = 0;
	DWORD		want = ( DWORD )Q_strlen( json );
	int		i;

	if( h9p_pipe == INVALID_HANDLE_VALUE )
		return false;

	for( i = 0; i < 4; i++ )
	{
		head[i] = ( uop >> ( 8 * i )) & 0xff;
		head[4 + i] = ( ulen >> ( 8 * i )) & 0xff;
	}

	if( !WriteFile( h9p_pipe, head, sizeof( head ), &written, NULL ) || written != sizeof( head ))
		return false;

	if( !WriteFile( h9p_pipe, json, want, &written, NULL ) || written != want )
		return false;

	return true;
}

/*
=================
H9P_Drain

Discord answers every frame. Nothing here reads the answers, but they are read off
the pipe so Discord never waits on a full one.
=================
*/
static void H9P_Drain( void )
{
	char	junk[512];

	for( ;; )
	{
		DWORD	avail = 0;
		DWORD	got = 0;
		DWORD	want;

		if( !PeekNamedPipe( h9p_pipe, NULL, 0, NULL, &avail, NULL ))
		{
			H9P_Close();
			return;
		}

		if( avail == 0 )
			return;

		want = avail < ( DWORD )sizeof( junk ) ? avail : ( DWORD )sizeof( junk );
		if( !ReadFile( h9p_pipe, junk, want, &got, NULL ))
		{
			H9P_Close();
			return;
		}
	}
}

/*
=================
H9P_Connect

Opens the first Discord pipe that answers, from discord-ipc-0 to discord-ipc-9, and
sends the handshake that names the application.
=================
*/
static qboolean H9P_Connect( void )
{
	char	name[64], json[256];
	int	i;

	for( i = 0; i < 10 && h9p_pipe == INVALID_HANDLE_VALUE; i++ )
	{
		Q_snprintf( name, sizeof( name ), "\\\\.\\pipe\\discord-ipc-%d", i );
		h9p_pipe = CreateFileA( name, GENERIC_READ|GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL );
	}

	if( h9p_pipe == INVALID_HANDLE_VALUE )
		return false;

	Q_snprintf( json, sizeof( json ), "{\"v\":1,\"client_id\":\"%s\"}", ts_richpresence_clientid.string );
	if( !H9P_Write( 0, json ))
	{
		H9P_Close();
		return false;
	}

	return true;
}

/*
=================
H9P_Mode

The card's word for the mode of the server we are on: CL_H9_ModeName's (the mode key it
publishes, then its map's name), or Deathmatch when that names nothing.
=================
*/
static const char *H9P_Mode( const char *map, const char *key, const char *siege )
{
	const char	*name = CL_H9_ModeName( map, key, siege );

	return name ? name : "Deathmatch";
}

/*
=================
H9P_Activity

Builds the activity object for the server we are on, as JSON. It holds no nonce, so two
builds of an unchanged card compare equal. Details is the mode (H9P_Mode), with its progress
where the server publishes one: the objectives and the side attacking them on a siege map,
each side's zones in Capture the Uplink (tsm_pres_prog "1/2/4/0": side 1's, side 2's, all,
the carrier's side), each side's points in Assault (tsm_pres_prog "1/2/5": side 1's, side 2's,
all), each side's captures in Capture the Flag (tsm_pres_prog "1/2/3": side 1's, side 2's, the
captures that win), the wave in Wave Survival. State is the players alive on each side out
of the total, the bots, and the map, or the totals alone from a plugin that does not publish
the alive counts. The large image is the map's snapshot, named after the map in the
application's art assets. The two buttons link to the Discord invite and the site. The party
is the people on the server out of its slots, bots left out ("3 of 64" beside the state), from
the server's own status reply.
=================
*/
static void H9P_Activity( char *out, size_t size )
{
	// each value copied out at once: Info_ValueForKey hands back one of four buffers it reuses,
	// so the fifth call would write over the first
	char		siege[16], attack[8], side1[8], side2[8], alive1[8], alive2[8], key[32], prog[32];
	char		details[96], state[160], title[160];

	Q_strncpy( siege, Info_ValueForKey( cl.serverinfo, "tsm_pres_siege" ), sizeof( siege ));
	Q_strncpy( attack, Info_ValueForKey( cl.serverinfo, "tsm_pres_attack" ), sizeof( attack ));
	Q_strncpy( side1, Info_ValueForKey( cl.serverinfo, "tsm_pres_side1" ), sizeof( side1 ));
	Q_strncpy( side2, Info_ValueForKey( cl.serverinfo, "tsm_pres_side2" ), sizeof( side2 ));
	Q_strncpy( alive1, Info_ValueForKey( cl.serverinfo, "tsm_pres_alive1" ), sizeof( alive1 ));
	Q_strncpy( alive2, Info_ValueForKey( cl.serverinfo, "tsm_pres_alive2" ), sizeof( alive2 ));
	Q_strncpy( key, Info_ValueForKey( cl.serverinfo, "tsm_pres_mode" ), sizeof( key ));
	Q_strncpy( prog, Info_ValueForKey( cl.serverinfo, "tsm_pres_prog" ), sizeof( prog ));

	const char	*atk = attack[0] == '1' ? H9P_SIDE1_NAME : ( attack[0] == '2' ? H9P_SIDE2_NAME : "" );
	const char	*mode = H9P_Mode( h9p.map, key, siege );
	char		e_details[192], e_state[320], e_map[160], e_title[320], party[64];

	if( siege[0] && atk[0] )
	{
		const char *slash = Q_strchr( siege, '/' );

		Q_snprintf( details, sizeof( details ), "%s - %s attacking: %d of %d objectives", mode, atk,
			Q_atoi( siege ), slash ? Q_atoi( slash + 1 ) : 0 );
	}
	else if( siege[0] )
		Q_snprintf( details, sizeof( details ), "%s %s", mode, siege );
	else if(( !Q_stricmp( key, "uplink" ) || !Q_stricmp( key, "assault" ) || !Q_stricmp( key, "ctf" )) && prog[0] )
	{
		const char	*p = prog;
		int		held[3] = { 0, 0, 0 };
		int		i;

		for( i = 0; i < 3 && p; i++ )
		{
			held[i] = Q_atoi( p );
			p = Q_strchr( p, '/' );
			if( p )
				p++;
		}

		if( !Q_stricmp( key, "ctf" ))
			Q_snprintf( details, sizeof( details ), "%s - captures: %s %d, %s %d (first to %d)", mode,
				H9P_SIDE1_NAME, held[0], H9P_SIDE2_NAME, held[1], held[2] );
		else
			Q_snprintf( details, sizeof( details ), "%s - %s: %s %d, %s %d of %d", mode,
				!Q_stricmp( key, "assault" ) ? "points" : "zones",
				H9P_SIDE1_NAME, held[0], H9P_SIDE2_NAME, held[1], held[2] );
	}
	else if( !Q_stricmp( key, "survival" ) && prog[0] )
		Q_snprintf( details, sizeof( details ), "%s - wave %d", mode, Q_atoi( prog ));
	else
		Q_strncpy( details, mode, sizeof( details ));

	if( alive1[0] && alive2[0] && side1[0] && side2[0] )
		Q_snprintf( state, sizeof( state ), "Alive: %s %s/%s, %s %s/%s, %d bots, %s", H9P_SIDE1_NAME,
			alive1, side1, H9P_SIDE2_NAME, alive2, side2, h9p.bots, h9p.map );
	else if( side1[0] && side2[0] )
		Q_snprintf( state, sizeof( state ), "%s %s vs %s %s, %d bots, %s", H9P_SIDE1_NAME, side1,
			H9P_SIDE2_NAME, side2, h9p.bots, h9p.map );
	else
		Q_snprintf( state, sizeof( state ), "%s, %d players, %d bots", h9p.map, h9p.players, h9p.bots );

	Q_snprintf( title, sizeof( title ), "HAVOC 9: %s", h9p.map );

	H9P_Escape( e_details, sizeof( e_details ), details );
	H9P_Escape( e_state, sizeof( e_state ), state );
	H9P_Escape( e_map, sizeof( e_map ), h9p.map );
	H9P_Escape( e_title, sizeof( e_title ), title );

	// the people out of the slots: the game itself is one of them, so never fewer than 1
	party[0] = '\0';
	if( h9p.valid && h9p.maxplayers > 0 )
		Q_snprintf( party, sizeof( party ), "\"party\":{\"size\":[%d,%d]},",
			bound( 1, h9p.players, h9p.maxplayers ), h9p.maxplayers );

	Q_snprintf( out, size,
		"{\"details\":\"%s\",\"state\":\"%s\",\"timestamps\":{\"start\":%d},%s"
		"\"assets\":{\"large_image\":\"%s\",\"large_text\":\"%s\","
		"\"small_image\":\"%s\",\"small_text\":\"HAVOC 9\"},"
		"\"buttons\":[{\"label\":\"%s\",\"url\":\"%s\"},{\"label\":\"%s\",\"url\":\"%s\"}]}",
		e_details, e_state, h9p.start, party, e_map, e_title, H9P_SMALL_KEY,
		H9P_BUTTON1_LABEL, H9P_BUTTON1_URL, H9P_BUTTON2_LABEL, H9P_BUTTON2_URL );
}


/*
=================
H9P_MenuActivity

The card for the main menu. There is no server to ask, so it says where the player is and
nothing about a match.
=================
*/
static void H9P_MenuActivity( char *out, size_t size )
{
	Q_snprintf( out, size,
		"{\"details\":\"In the main menu\",\"state\":\"Not in a server\",\"timestamps\":{\"start\":%d},"
		"\"assets\":{\"large_image\":\"%s\",\"large_text\":\"HAVOC 9\","
		"\"small_image\":\"%s\",\"small_text\":\"HAVOC 9\"},"
		"\"buttons\":[{\"label\":\"%s\",\"url\":\"%s\"},{\"label\":\"%s\",\"url\":\"%s\"}]}",
		h9p.start, H9P_MENU_KEY, H9P_SMALL_KEY,
		H9P_BUTTON1_LABEL, H9P_BUTTON1_URL, H9P_BUTTON2_LABEL, H9P_BUTTON2_URL );
}

/*
=================
H9P_Hide

Takes the card down, if one is up, and forgets the server we were on.
=================
*/
static void H9P_Hide( void )
{
	char	json[128];

	if( h9p.shown && h9p_pipe != INVALID_HANDLE_VALUE )
	{
		Q_snprintf( json, sizeof( json ),
			"{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":%lu,\"activity\":null},\"nonce\":\"%d\"}",
			( unsigned long )GetCurrentProcessId(), ++h9p.nonce );
		if( !H9P_Write( 1, json ))
			H9P_Close();
	}

	h9p.shown = false;
	h9p.onmenu = false;
	h9p.valid = false;
	h9p.start = 0;
	h9p.sent[0] = '\0';
}
#else
static void H9P_Hide( void ) {}
#endif

/*
=================
CL_Presence_Init
=================
*/
void CL_Presence_Init( void )
{
	Cvar_RegisterVariable( &ts_richpresence );
	Cvar_RegisterVariable( &ts_richpresence_clientid );

	// the release of this game, in the userinfo of every join: a server that holds its players to one release looks at it. The cvar shows
	// it in the console; a cvar set this way never reaches the userinfo (that is the ordinary setters' own step), so the key is written
	// there as the game's other keys are (cl_travel.c): the userinfo is what the connect packet carries
	Cvar_RegisterVariable( &h9_rel );
	Cvar_DirectFullSet( &h9_rel, H9_Release(), 0 );

	if( H9_Release()[0] )
		Info_SetValueForKey( CL_Userinfo(), "_h9rel", H9_Release(), MAX_INFO_STRING );
}

/*
=================
CL_Presence_ServerReply

Called for every status reply the client parses. Only the reply from the server we are
connected to counts, and it sets the map, the players and the bots for the card.
=================
*/
void CL_Presence_ServerReply( netadr_t from, const char *info )
{
	if( !NET_CompareAdr( from, cls.serveradr ))
		return;

	Q_strncpy( h9p.map, Info_ValueForKey( info, "map" ), sizeof( h9p.map ));
	h9p.players = Q_atoi( Info_ValueForKey( info, "numcl" ));
	h9p.bots = Q_atoi( Info_ValueForKey( info, "bots" ));
	h9p.maxplayers = Q_atoi( Info_ValueForKey( info, "maxcl" ));
	h9p.valid = true;
}

/*
=================
CL_Presence_Frame

Runs once a frame. While the game is connected it asks the server for its status every
H9P_INTERVAL seconds, and sends the card when what it shows has changed. In the main menu
it shows the menu card. Off, or while connecting or in a demo, it takes the card down.
=================
*/
void CL_Presence_Frame( void )
{
#if XASH_WIN32
	char	activity[H9P_CARD_MAX];
	char	message[H9P_CARD_MAX + 128];
	qboolean	inmenu = cls.state == ca_disconnected;
	static qboolean	dbg_gate1, dbg_gate3, dbg_gate4, dbg_gate5, dbg_gate6, dbg_shown;

	if( !ts_richpresence.value || CL_IsPlaybackDemo( ) || ( cls.state != ca_active && !inmenu ))
	{
		if( inmenu && !dbg_gate1 )
		{
			Con_Printf( "richpresence: gate1 hide -- richpresence=%g demo=%d state=%d inmenu=%d\n",
				ts_richpresence.value, CL_IsPlaybackDemo(), cls.state, inmenu );
			dbg_gate1 = true;
		}
		H9P_Hide();
		return;
	}

	if( !ts_richpresence_clientid.string[0] )
	{
		if( !h9p.warned )
			Con_Printf( S_WARN "ts_richpresence: no Discord application ID is set (ts_richpresence_clientid). See docs\\RICH_PRESENCE.txt.\n" );
		h9p.warned = true;
		return;
	}

	if( !inmenu )
	{
		if( host.realtime - h9p.queried >= H9P_INTERVAL )
		{
			h9p.queried = host.realtime;
			NET_QueryServerByAddress( cls.serveradr, PROTO_CURRENT );
		}

		if( !h9p.valid )
		{
			if( !dbg_gate3 )
			{
				Con_Printf( "richpresence: gate3 waiting on server status reply\n" );
				dbg_gate3 = true;
			}
			return;
		}
	}

	if( h9p_pipe == INVALID_HANDLE_VALUE )
	{
		if( host.realtime < h9p.retry )
		{
			if( inmenu && !dbg_gate4 )
			{
				Con_Printf( "richpresence: gate4 waiting on retry cooldown, %.1fs left\n", h9p.retry - host.realtime );
				dbg_gate4 = true;
			}
			return;
		}

		if( !H9P_Connect( ))
		{
			if( inmenu && !dbg_gate5 )
			{
				Con_Printf( "richpresence: gate5 H9P_Connect failed, err=%lu\n", GetLastError() );
				dbg_gate5 = true;
			}
			h9p.retry = host.realtime + H9P_RETRY;
			return;
		}
	}

	H9P_Drain();
	if( h9p_pipe == INVALID_HANDLE_VALUE )
	{
		if( inmenu && !dbg_gate6 )
		{
			Con_Printf( "richpresence: gate6 pipe dropped after H9P_Drain\n" );
			dbg_gate6 = true;
		}
		return;
	}

	if( inmenu && !dbg_shown )
	{
		Con_Printf( "richpresence: reached card-send path for menu\n" );
		dbg_shown = true;
	}

	if( inmenu != h9p.onmenu )
	{
		h9p.onmenu = inmenu;
		h9p.start = 0;
	}

	if( !h9p.start )
		h9p.start = ( int )time( NULL );

	if( inmenu )
		H9P_MenuActivity( activity, sizeof( activity ));
	else
		H9P_Activity( activity, sizeof( activity ));
	if( !Q_strcmp( activity, h9p.sent ))
		return;
	if( host.realtime < h9p.sendat )
		return;

	Q_snprintf( message, sizeof( message ),
		"{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":%lu,\"activity\":%s},\"nonce\":\"%d\"}",
		( unsigned long )GetCurrentProcessId(), activity, ++h9p.nonce );

	if( !H9P_Write( 1, message ))
	{
		H9P_Close();
		h9p.retry = host.realtime + H9P_RETRY;
		return;
	}

	h9p.sendat = host.realtime + H9P_SEND_GAP;
	Q_strncpy( h9p.sent, activity, sizeof( h9p.sent ));
	h9p.shown = true;
#else
	h9p.valid = false;
#endif
}

/*
=================
CL_Presence_Shutdown
=================
*/
void CL_Presence_Shutdown( void )
{
	H9P_Hide();
#if XASH_WIN32
	H9P_Close();
#endif
}
