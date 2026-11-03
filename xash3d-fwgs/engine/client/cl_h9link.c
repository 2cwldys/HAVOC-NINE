/*
cl_h9link.c - H9: this game's id kept protected, and linking it to a havoc9.org account (docs/CUSTOM_XASH_USERID.txt)
Copyright (C) 2026 HAVOC 9

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

THE ID. cl_h9_userid (engine-h9-userid.patch) is this install's id: identification.c salts it per
server into h9_clientid, and the ID proof (cl_idproof.c, cl_h9listen.c) keys its HMAC with it. This
file keeps it in user_id.ini in the root folder, protected for this Windows user:

  [client]
  protected=<hex>    the record below, sealed with CryptProtectData (DPAPI, crypt32.dll, loaded
                     here), with an entropy of this file's own as a second key
  protected=<hex>    records this Windows user cannot open (another user's, or the other system
                     of a dual boot), kept as they were, at most H9L_OTHERS of them

The record inside is a few lines of text: h9id=1, id=<32 hex>, and, once the game is linked,
linked=<the id that was linked>, account=<the account's username>, token=<the link token>. The
game reads the file itself at start, sets cl_h9_userid from it, takes FCVAR_ARCHIVE off the cvar
(config.cfg no longer keeps it) and makes it read-only (no config or console can set it). A plain
id=<32 hex> line, as older H9XASH, enter_userid.cmd or a hand edit leave it, is taken as the id and
sealed at once, and user_id.ini.bak (an older id in plain text) is deleted. A file with no record
this user can open, or no file, gets a new random id. Copied to another PC or Windows account, the
file opens for nobody there: the game makes a new id and is not linked.

Under Wine and Proton the same calls go to Wine's own crypt32, whose DPAPI is keyed to the user name
alone: the id is out of plain sight, not locked to the account. A CryptProtectData that fails keeps
the id as plain id= text, and says so in the console.

LINKED means the record holds linked=, account=, token= and site=, and linked= is the id. A plain
id that is not the linked one (enter_userid.cmd with another id), a new id (h9_regenerate_userid.bat,
or the file deleted) and h9_unlink all end it. The userinfo key _h9lnk is "1" while linked and "0"
while not: servers read it (h9_link.sma), and so does the main menu's Link your Account / Unlink
your Account button (mainui-h9-link.patch), with _h9link_account. While the menu is up and no server
is connected, the file is looked at every H9L_FILE_CHECK seconds, so a deleted or changed file shows
in the button at once, with no network call.

A link belongs to the site that made it, kept in the record as site=: https://havoc9.org, or the
local test site cl_h9_site named while the code was up. The start's status check asks that site
alone, and only while cl_h9_site points to it; only its answer can unlink the game, and h9_unlink
tells it. A link made on the local test site, with cl_h9_site cleared since, stays as it is: the
game keeps its id and its link, and checks again once cl_h9_site names that site again.

LINKING (lib/link.js in h9web, RFC 8628's device flow), all through the engine's HTTP client, GET
only, to https://havoc9.org with its certificate checked (cl_h9_site may name the local test site,
as cl_avatar.c allows):
  h9_link          GET /api/link/start?v=1&device=<device hash>&os=windows|wine: a code such as
                   WDJB-MJHT. The game shows it (in the main menu, mainui's dialog; in a game, this
                   file's panel) and polls GET /api/link/poll?code=<device code> every interval
                   seconds until the code is approved on <site>/link/, turned down, or runs out.
                   Approved, the answer brings the account's player id, its username and a link
                   token: the record takes them, is sealed and written, and cl_h9_userid is the
                   account's player id from then on. Connected to a server, h9_clientid is salted
                   again and sent, so the server sees the account at once.
  h9_link open     opens <site>/link/?code=<the code> in the system browser
  h9_link cancel   drops the code
  h9_unlink        a new random id, the link gone; the link's site is told (GET /api/link/unlink)
The device hash is presence's form of the device id in device_id.ini: SHA-256("h9device1:" + its 16
bytes), the first 32 hex. Once a start of a linked game, H9L_STATUS_DELAY seconds in, GET
<the link's site>/api/link/status?token=<token> asks whether the link still stands; "unlinked"
(REVOKE on the ACCOUNT page, or the account's player id reset) unlinks the game here as h9_unlink
does. The texts the player sees name the site the code comes from (_h9link_site for the menu).

THE SITE. cl_h9_site may name the local test site as http://127.0.0.1:<port>, http://localhost:<port>,
or without the scheme (127.0.0.1:<port>, which needs no quotes: unquoted, the console takes the //
of http:// for a comment); a slash at the end does not matter. Anything else, and nothing, is
https://havoc9.org. What the game takes is kept in its canonical form (http://host:port), and the
site in use is said in the console a moment after start and whenever cl_h9_site changes, with why
a value was not taken.

ADOPTING. A record with an id and no link (an id put in by enter_userid.cmd, or from before linking)
asks the site in use whether its id is an account's, ten seconds after start and while the main
menu is up, once for each id and site (again a minute after a try that got no answer): GET
/api/link/adopt/nonce, then GET /api/link/adopt with key = HMAC-SHA256(the id, "h9adopt-key1"),
the first 32 hex, and the ID proof's devmask and proof for that nonce with S = "h9link-adopt"
(cl_idproof.c's H9_IdProof). The raw id never travels. When the id is an account's the answer
brings the account's username and a link token for this device, and the record is linked, with
that site, as a code's approval links it.

A server may send h9_link (h9_link.sma's .link sends it), as an ordinary command, so cl_filterstuffcmd
lets it through: it can only put up the code. Opening the browser, cancelling and h9_unlink are the
player's alone: "open" and "cancel" from a server are ignored, and h9_unlink is privileged. A server
starts at most H9L_SERVER_BURST codes in H9L_SERVER_WINDOW seconds, and none while one is up.

The browser build has none of this: the web client is signed in to its account already, and sets
cl_h9_userid itself. A test build compiles the store and the parsing alone, with H9_LINK_SELFTEST
defined and the engine's few calls supplied by the test.
*/

#ifndef H9_LINK_SELFTEST
#include "common.h"
#include "client.h"
#include "keydefs.h"
#include "net_ws.h"
#include "platform/platform.h"
#include "cl_motd.h"
#endif

#if XASH_WIN32 && !XASH_EMSCRIPTEN

#define H9_IDPROOF_SELFTEST
#include "cl_idproof.c"
#undef H9_IDPROOF_SELFTEST

#include <windows.h>
#include <sys/types.h>
#include <sys/stat.h>

// RtlGenRandom, as ntsecapi.h declares it (advapi32, which the engine links)
BOOLEAN NTAPI SystemFunction036( PVOID RandomBuffer, ULONG RandomBufferLength );

#define H9L_SITE           "https://havoc9.org"
#define H9L_OTHERS         3      // records of other Windows users kept in user_id.ini
#define H9L_BLOB_MAX       2048   // bytes of a sealed record
#define H9L_FILE_MAX       16384  // bytes of user_id.ini
#define H9L_FILE_CHECK     2.0    // seconds between looks at user_id.ini while the menu is up
#define H9L_STATUS_DELAY   10.0   // seconds after start before a linked game asks whether it still is
#define H9L_NOTICE         8.0    // seconds a result stays on screen in a game
#define H9L_SERVER_WINDOW  600.0  // a server's h9_link: at most H9L_SERVER_BURST in this many seconds
#define H9L_SERVER_BURST   3
#define H9L_POLL_FAILURES  6      // polls in a row that may fail before the code is dropped
#define H9L_ENTROPY        "h9xash user_id.ini v1"

enum
{
	H9LF_IDLE = 0,  // no code
	H9LF_ASKING,    // asking havoc9.org for a code
	H9LF_WAITING,   // the code is up, waiting for its approval
	H9LF_LINKED,    // linked, just now
	H9LF_FAILED     // the last code came to nothing (_h9link_text says why)
};

enum
{
	H9L_BTN_OPEN = 0,
	H9L_BTN_CLOSE,
	H9L_BTN_COUNT
};

typedef struct
{
	char id[33];      // 32 lowercase hex
	char linked[33];  // the id that was linked, or ""
	char account[32]; // the account's username, while linked
	char token[48];   // the link token (43 base64url), while linked
	char site[64];    // the site the link belongs to (H9L_SITE or a local test site), while linked
} h9l_record_t;

// DATA_BLOB, and crypt32's two calls, as wincrypt.h declares them
typedef struct
{
	DWORD cbData;
	BYTE  *pbData;
} h9l_blob_t;

typedef BOOL ( WINAPI *pfnProtect_t )( h9l_blob_t *in, LPCWSTR desc, h9l_blob_t *entropy, PVOID reserved, PVOID prompt, DWORD flags, h9l_blob_t *out );
typedef BOOL ( WINAPI *pfnUnprotect_t )( h9l_blob_t *in, LPWSTR *desc, h9l_blob_t *entropy, PVOID reserved, PVOID prompt, DWORD flags, h9l_blob_t *out );
#define H9L_CRYPTPROTECT_UI_FORBIDDEN 0x1

static CVAR_DEFINE( cl_h9lnk, "_h9lnk", "0", FCVAR_USERINFO|FCVAR_PRIVILEGED, "H9: 1 while this game is linked to a havoc9.org account (set by the engine, cl_h9link.c)" );
static CVAR_DEFINE( cl_h9link_account, "_h9link_account", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the havoc9.org account this game is linked to (set by the engine)" );
static CVAR_DEFINE( cl_h9link_flow, "_h9link_flow", "0", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: h9_link's code: 0 none, 1 asking, 2 waiting for its approval, 3 linked, 4 failed (set by the engine)" );
static CVAR_DEFINE( cl_h9link_code, "_h9link_code", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the code h9_link shows (set by the engine)" );
static CVAR_DEFINE( cl_h9link_text, "_h9link_text", "", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: where h9_link stands, in words (set by the engine)" );
static CVAR_DEFINE( cl_h9link_site, "_h9link_site", "havoc9.org", FCVAR_PRIVILEGED|FCVAR_READ_ONLY, "H9: the site h9_link's code comes from, as the player reads it (set by the engine)" );

static struct
{
	h9l_record_t rec;
	qboolean     loaded;    // the id came from the store (or was made) this session
	qboolean     plain;     // the store could not be sealed: the id is kept as plain text
	char         others[H9L_OTHERS][H9L_BLOB_MAX * 2 + 1];
	int          numothers;

	// user_id.ini as last read or written
	qboolean     file_exists;
	__int64      file_mtime;
	__int64      file_size;
	double       next_file_check;

	pfnProtect_t   protect;
	pfnUnprotect_t unprotect;
	qboolean       crypt_looked;

	// the code
	int      flow;
	char     user_code[16];   // WDJB-MJHT
	char     device_code[48];
	char     flow_site[64];   // the site the code comes from: polled there, and the link's site
	int      interval;
	double   expires_at;
	double   next_poll_at;
	int      generation;      // an answer counts only for the code that asked
	qboolean asking;          // a request of the code is out
	int      poll_failures;
	char     text[160];
	int      shown_seconds;   // the time left last written into the text
	double   notice_until;    // a result on screen in a game until then

	// a server's h9_link
	double   server_starts[H9L_SERVER_BURST];
	int      next_server_start;

	// the panel in a game
	qboolean    panel_up;
	h9ui_rect_t btn[H9L_BTN_COUNT];
	byte        eat[256];

	// the site in use, as last said in the console
	char     site_value[96];
	qboolean site_said;

	// adopting the id the record holds
	qboolean adopt_asking;
	qboolean adopt_started;   // the start's try has gone
	qboolean adopt_done;      // adopt_for has its answer
	char     adopt_for[128];  // "<id>|<site>" of the last try
	char     adopt_id[33];    // the id the proof in flight is for
	char     adopt_site[64];
	double   adopt_next;      // no try before then
	int      adopt_gen;

	// the start's status check
	qboolean status_done;
	char     status_token[48];
	double   started_at;
} h9l;

/*
==============================================================================

	THE STORE: user_id.ini

==============================================================================
*/

static qboolean H9L_RandomBytes( uint8_t *out, size_t n )
{
	return SystemFunction036( out, (ULONG)n ) ? true : false;
}

static void H9L_NewId( char out[33] )
{
	uint8_t b[16];

	if( !H9L_RandomBytes( b, sizeof( b )))
	{
		// RtlGenRandom does not fail on any Windows this runs on; this is never reached in practice
		for( int i = 0; i < 16; i++ )
			b[i] = (uint8_t)( COM_RandomLong( 0, 255 ));
	}
	H9_ToHex( b, sizeof( b ), out );
}

static qboolean H9L_Path( char *out, size_t size, const char *name )
{
	char root[MAX_SYSPATH];

	if( !g_fsapi.GetRootDirectory( root, sizeof( root )))
		return false;
	Q_snprintf( out, size, "%s/%s", root, name );
	return true;
}

static qboolean H9L_Crypt( void )
{
	if( !h9l.crypt_looked )
	{
		HMODULE dll = LoadLibraryA( "crypt32.dll" );

		h9l.crypt_looked = true;
		if( dll )
		{
			h9l.protect = (pfnProtect_t)GetProcAddress( dll, "CryptProtectData" );
			h9l.unprotect = (pfnUnprotect_t)GetProcAddress( dll, "CryptUnprotectData" );
		}
		if( !h9l.protect || !h9l.unprotect )
			Con_Printf( S_WARN "crypt32.dll has no CryptProtectData: this game's id is kept as plain text in user_id.ini\n" );
	}
	return h9l.protect && h9l.unprotect;
}

// a line's value, cut of spaces at both ends; NULL when the line is not "key=value"
static const char *H9L_KeyValue( char *line, char **key )
{
	char *eq = Q_strchr( line, '=' );
	size_t n;

	if( !eq || eq == line )
		return NULL;
	*eq++ = 0;
	while( *line == ' ' || *line == '\t' )
		line++;
	for( n = Q_strlen( line ); n > 0 && ( line[n - 1] == ' ' || line[n - 1] == '\t' ); n-- )
		line[n - 1] = 0;
	*key = line;
	while( *eq == ' ' || *eq == '\t' )
		eq++;
	for( n = Q_strlen( eq ); n > 0 && ( eq[n - 1] == ' ' || eq[n - 1] == '\t' || eq[n - 1] == '\r' ); n-- )
		eq[n - 1] = 0;
	return eq;
}

// 32 hex in any case, lowered into out
static qboolean H9L_IdOf( const char *s, char out[33] )
{
	int i;

	for( i = 0; i < 32; i++ )
	{
		char c = s[i];

		if( c >= 'A' && c <= 'F' )
			c = c - 'A' + 'a';
		if( !(( c >= '0' && c <= '9' ) || ( c >= 'a' && c <= 'f' )))
			return false;
		out[i] = c;
	}
	out[32] = 0;
	return s[32] == 0;
}

static qboolean H9L_IsToken( const char *s )
{
	int i;

	for( i = 0; i < 43; i++ )
	{
		char c = s[i];

		if( !(( c >= 'A' && c <= 'Z' ) || ( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) || c == '-' || c == '_' ))
			return false;
	}
	return s[43] == 0;
}

// an account's username as h9web makes them: 3 to 20 of a-z, A-Z, 0-9, . _ -
static qboolean H9L_IsAccount( const char *s )
{
	int n = 0;

	for( ; *s; s++, n++ )
	{
		if( !(( *s >= 'A' && *s <= 'Z' ) || ( *s >= 'a' && *s <= 'z' ) || ( *s >= '0' && *s <= '9' ) || *s == '.' || *s == '_' || *s == '-' ))
			return false;
	}
	return n >= 3 && n <= 20;
}

// a sealed record's form: hex, whole bytes, no longer than H9L_BLOB_MAX
static qboolean H9L_IsBlob( const char *s )
{
	size_t n = Q_strlen( s ), i;

	if( n < 2 || n % 2 || n > H9L_BLOB_MAX * 2 )
		return false;
	for( i = 0; i < n; i++ )
	{
		if( H9_HexValue( s[i] ) < 0 )
			return false;
	}
	return true;
}

// http://127.0.0.1:<port> or http://localhost:<port>, the port 1 to 65535 with no leading zero, and
// nothing else (cl_avatar.c's rule)
static qboolean H9L_LocalSite( const char *s )
{
	const char *p;
	int digits = 0, port = 0;

	if( !Q_strncmp( s, "http://127.0.0.1:", 17 ) || !Q_strncmp( s, "http://localhost:", 17 ))
		p = s + 17;
	else return false;

	if( *p == '0' )
		return false;
	for( ; *p; p++, digits++ )
	{
		if( *p < '0' || *p > '9' || digits >= 5 )
			return false;
		port = port * 10 + ( *p - '0' );
	}
	return digits >= 1 && port <= 65535;
}

// What cl_h9_site names: 1 a local test site, written into out in its canonical form
// ("http://127.0.0.1:8090": the scheme added when it is left out, the host in lower case, slashes at
// the end dropped), 0 havoc9.org (empty, or https://havoc9.org itself), -1 nothing it may name,
// -2 http: or https: alone, which is what the console leaves of an unquoted address (// is a comment)
static int H9L_SiteOf( const char *value, char *out, size_t size )
{
	char v[96];
	const char *hostport;
	size_t n;

	while( *value == ' ' || *value == '\t' )
		value++;
	Q_strncpy( v, value, sizeof( v ));
	for( n = Q_strlen( v ); n > 0 && ( v[n - 1] == '/' || v[n - 1] == ' ' || v[n - 1] == '\t' ); n-- )
		v[n - 1] = 0;
	if( !v[0] || !Q_stricmp( v, H9L_SITE ))
		return 0;
	if( !Q_stricmp( v, "http:" ) || !Q_stricmp( v, "https:" ))
		return -2;
	hostport = !Q_strnicmp( v, "http://", 7 ) ? v + 7 : v;
	if( Q_strstr( hostport, "://" ) || Q_strlen( hostport ) + 8 > size )
		return -1;
	Q_snprintf( out, size, "http://%s", hostport );
	for( n = 7; out[n]; n++ )
	{
		if( out[n] >= 'A' && out[n] <= 'Z' )
			out[n] = out[n] - 'A' + 'a';
	}
	return H9L_LocalSite( out ) ? 1 : -1;
}

// a site a link may belong to: havoc9.org, or a local test site
static qboolean H9L_IsSite( const char *s )
{
	return !Q_strcmp( s, H9L_SITE ) || H9L_LocalSite( s );
}

// a site as the player reads it: havoc9.org, 127.0.0.1:8090
static const char *H9L_SiteName( const char *site )
{
	if( !Q_strncmp( site, "https://", 8 ))
		return site + 8;
	if( !Q_strncmp( site, "http://", 7 ))
		return site + 7;
	return site;
}

static qboolean H9L_Linked( const h9l_record_t *r )
{
	return r->linked[0] && r->account[0] && r->token[0] && r->site[0] && !Q_strcmp( r->linked, r->id );
}

static void H9L_ClearLink( h9l_record_t *r )
{
	r->linked[0] = r->account[0] = r->token[0] = r->site[0] = 0;
}

// the record's text, sealed into hex: false when it cannot be sealed
static qboolean H9L_Seal( const h9l_record_t *r, char *hex, size_t size )
{
	char text[256];
	h9l_blob_t in, out, entropy;
	int n;

	if( !H9L_Crypt( ))
		return false;

	if( H9L_Linked( r ))
		n = Q_snprintf( text, sizeof( text ), "h9id=1\nid=%s\nlinked=%s\naccount=%s\ntoken=%s\nsite=%s\n", r->id, r->linked, r->account, r->token, r->site );
	else n = Q_snprintf( text, sizeof( text ), "h9id=1\nid=%s\n", r->id );

	in.cbData = (DWORD)n;
	in.pbData = (BYTE *)text;
	entropy.cbData = (DWORD)( sizeof( H9L_ENTROPY ) - 1 );
	entropy.pbData = (BYTE *)H9L_ENTROPY;
	out.cbData = 0;
	out.pbData = NULL;

	if( !h9l.protect( &in, L"H9XASH user id", &entropy, NULL, NULL, H9L_CRYPTPROTECT_UI_FORBIDDEN, &out ))
	{
		memset( text, 0, sizeof( text ));
		return false;
	}
	memset( text, 0, sizeof( text ));

	if( out.cbData > H9L_BLOB_MAX || out.cbData * 2 + 1 > size )
	{
		LocalFree( out.pbData );
		return false;
	}
	H9_ToHex( out.pbData, out.cbData, hex );
	LocalFree( out.pbData );
	return true;
}

// a sealed record this Windows user can open, read into r
static qboolean H9L_Open( const char *hex, h9l_record_t *r )
{
	static uint8_t blob[H9L_BLOB_MAX];
	char text[257], *line, *next;
	h9l_blob_t in, out, entropy;
	size_t len = Q_strlen( hex ), i;
	qboolean magic = false;

	if( !H9L_Crypt( ) || len < 2 || len % 2 || len / 2 > sizeof( blob ))
		return false;
	for( i = 0; i < len / 2; i++ )
	{
		int hi = H9_HexValue( hex[i * 2] ), lo = H9_HexValue( hex[i * 2 + 1] );

		if( hi < 0 || lo < 0 )
			return false;
		blob[i] = (uint8_t)( hi * 16 + lo );
	}

	in.cbData = (DWORD)( len / 2 );
	in.pbData = blob;
	entropy.cbData = (DWORD)( sizeof( H9L_ENTROPY ) - 1 );
	entropy.pbData = (BYTE *)H9L_ENTROPY;
	out.cbData = 0;
	out.pbData = NULL;
	if( !h9l.unprotect( &in, NULL, &entropy, NULL, NULL, H9L_CRYPTPROTECT_UI_FORBIDDEN, &out ))
		return false;
	if( out.cbData >= sizeof( text ))
	{
		SecureZeroMemory( out.pbData, out.cbData );
		LocalFree( out.pbData );
		return false;
	}
	memcpy( text, out.pbData, out.cbData );
	text[out.cbData] = 0;
	SecureZeroMemory( out.pbData, out.cbData );
	LocalFree( out.pbData );

	memset( r, 0, sizeof( *r ));
	for( line = text; line && *line; line = next )
	{
		const char *value;
		char *key;

		next = Q_strchr( line, '\n' );
		if( next )
			*next++ = 0;
		value = H9L_KeyValue( line, &key );
		if( !value )
			continue;
		if( !Q_strcmp( key, "h9id" ))
			magic = !Q_strcmp( value, "1" );
		else if( !Q_strcmp( key, "id" ))
			H9L_IdOf( value, r->id );
		else if( !Q_strcmp( key, "linked" ))
			H9L_IdOf( value, r->linked );
		else if( !Q_strcmp( key, "account" ) && H9L_IsAccount( value ))
			Q_strncpy( r->account, value, sizeof( r->account ));
		else if( !Q_strcmp( key, "token" ) && H9L_IsToken( value ))
			Q_strncpy( r->token, value, sizeof( r->token ));
		else if( !Q_strcmp( key, "site" ) && H9L_IsSite( value ))
			Q_strncpy( r->site, value, sizeof( r->site ));
	}
	memset( text, 0, sizeof( text ));

	if( !magic || !r->id[0] )
		return false;
	if( r->linked[0] && !r->site[0] )
		Q_strncpy( r->site, H9L_SITE, sizeof( r->site )); // a record from before site=: havoc9.org's
	if( !H9L_Linked( r ))
		H9L_ClearLink( r );
	return true;
}

static void H9L_NoteFile( const char *path )
{
	struct _stat64 st;

	if( _stat64( path, &st ) == 0 )
	{
		h9l.file_exists = true;
		h9l.file_mtime = st.st_mtime;
		h9l.file_size = st.st_size;
	}
	else
	{
		h9l.file_exists = false;
		h9l.file_mtime = h9l.file_size = 0;
	}
}

// user_id.ini written whole, through a temporary file
static qboolean H9L_Write( void )
{
	char path[MAX_SYSPATH], tmp[MAX_SYSPATH];
	static char mine[H9L_BLOB_MAX * 2 + 1];
	qboolean sealed;
	FILE *f;
	int i;

	if( !H9L_Path( path, sizeof( path ), "user_id.ini" ) || !H9L_Path( tmp, sizeof( tmp ), "user_id.ini.tmp" ))
		return false;

	sealed = H9L_Seal( &h9l.rec, mine, sizeof( mine ));
	h9l.plain = !sealed;

	f = fopen( tmp, "wb" );
	if( !f )
	{
		Con_Printf( S_ERROR "could not write %s\n", tmp );
		return false;
	}
	fprintf( f, "; user_id.ini -- this install's client id. The engine reads and writes this file.\r\n" );
	fprintf( f, "; The id is kept protected for this Windows user (DPAPI): copied to another PC or\r\n" );
	fprintf( f, "; Windows account it cannot be read there, and the game makes a new id in its place.\r\n" );
	fprintf( f, "; Link the game to your havoc9.org account from the main menu (Link your Account).\r\n" );
	fprintf( f, "; Delete this file, or run h9_regenerate_userid.bat, for a new random id. A plain\r\n" );
	fprintf( f, "; id= line (enter_userid.cmd) is taken and protected at the next start. The engine\r\n" );
	fprintf( f, "; never sends this id as-is to a server -- see docs\\CUSTOM_XASH_USERID.txt.\r\n" );
	fprintf( f, "\r\n[client]\r\n" );
	if( sealed )
		fprintf( f, "protected=%s\r\n", mine );
	else fprintf( f, "id=%s\r\n", h9l.rec.id );
	for( i = 0; i < h9l.numothers; i++ )
		fprintf( f, "protected=%s\r\n", h9l.others[i] );
	if( fclose( f ) != 0 )
	{
		remove( tmp );
		Con_Printf( S_ERROR "could not write %s\n", tmp );
		return false;
	}

	if( !MoveFileExA( tmp, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH ))
	{
		remove( path );
		if( rename( tmp, path ) != 0 )
		{
			remove( tmp );
			Con_Printf( S_ERROR "could not replace %s\n", path );
			return false;
		}
	}
	H9L_NoteFile( path );

	if( !sealed )
		Con_Printf( S_WARN "this game's id could not be protected: user_id.ini keeps it as plain text\n" );
	return true;
}

// the record into the cvars: cl_h9_userid, _h9lnk and _h9link_account
static void H9L_Apply( void )
{
	const qboolean linked = H9L_Linked( &h9l.rec );

	Cvar_DirectFullSet( &cl_h9_userid, h9l.rec.id, 0 );
	Cvar_DirectFullSet( &cl_h9link_account, linked ? h9l.rec.account : "", 0 );
	if( Q_strcmp( cl_h9lnk.string, linked ? "1" : "0" ))
		Cvar_DirectSet( &cl_h9lnk, linked ? "1" : "0" );
}

#ifndef H9_LINK_SELFTEST
// Connected to a server whose h9_clientid the connect packet set: salted again with the id now, and
// sent. Over loopback, cl_h9listen.c salts it at the listen server's next h9_idlisten.
static void H9L_Resalt( void )
{
	char key[64];
	netadrtype_t type;

	if( cls.state < ca_connected || cls.demoplayback )
		return;
	type = NET_NetadrType( &cls.netchan.remote_address );
	if( type != NA_IP && type != NA_IP6 )
		return;
	if( !Info_ValueForKey( cls.userinfo, "h9_clientid" )[0] )
		return;
	ID_GetMD5ForAddressEx( key, cls.netchan.remote_address, sizeof( key ), cl_h9_userid.string );
	if( Q_strcmp( Info_ValueForKey( cls.userinfo, "h9_clientid" ), key ))
	{
		Info_SetValueForKey( cls.userinfo, "h9_clientid", key, sizeof( cls.userinfo ));
		CL_UpdateInfo( "h9_clientid", key );
	}
}

#endif // !H9_LINK_SELFTEST

// A string or a number from h9web's flat JSON answer: "key":"value" with no escapes, or "key":123.
static qboolean H9L_Json( const char *json, const char *key, char *out, size_t size )
{
	char want[40];
	const char *p, *end;
	size_t n;

	Q_snprintf( want, sizeof( want ), "\"%s\"", key );
	p = Q_strstr( json, want );
	if( !p )
		return false;
	p += Q_strlen( want );
	while( *p == ' ' )
		p++;
	if( *p++ != ':' )
		return false;
	while( *p == ' ' )
		p++;
	if( *p == '"' )
	{
		p++;
		end = Q_strchr( p, '"' );
		if( !end )
			return false;
		for( n = 0; p + n < end; n++ )
		{
			if( p[n] == '\\' || (byte)p[n] < ' ' || (byte)p[n] > '~' )
				return false;
		}
	}
	else
	{
		end = p;
		while( *end >= '0' && *end <= '9' )
			end++;
		if( end == p )
			return false;
	}
	n = end - p;
	if( n + 1 > size )
		return false;
	memcpy( out, p, n );
	out[n] = 0;
	return true;
}

// the answer's body, as a string: false when it is no answer at all
static qboolean H9L_Body( qboolean success, const byte *data, size_t size, char *out, size_t outsize )
{
	if( !success || !data || !size || size + 1 > outsize )
		return false;
	memcpy( out, data, size );
	out[size] = 0;
	return true;
}

// "WDJB-MJHT": 8 letters of RFC 8628's alphabet with a hyphen in the middle
static qboolean H9L_IsUserCode( const char *s )
{
	static const char alphabet[] = "BCDFGHJKLMNPQRSTVWXZ";
	int i;

	for( i = 0; i < 9; i++ )
	{
		if( i == 4 ? s[i] != '-' : !s[i] || !Q_strchr( alphabet, s[i] ))
			return false;
	}
	return s[9] == 0;
}

// the device hash h9web keeps (presence's form), from device_id.ini; "" when there is none
// the device id in device_id.ini (cl_idproof.c makes it): false when there is none
static qboolean H9L_DeviceRead( uint8_t device[16] )
{
	char path[MAX_SYSPATH], text[512];
	const char *id;
	FILE *f;
	size_t n;
	int i;

	if( !H9L_Path( path, sizeof( path ), "device_id.ini" ) || !( f = fopen( path, "rb" )))
		return false;
	n = fread( text, 1, sizeof( text ) - 1, f );
	fclose( f );
	text[n] = 0;
	if( !( id = Q_strstr( text, "id=" )))
		return false;
	id += 3;
	for( i = 0; i < 16; i++ )
	{
		int hi = H9_HexValue( id[i * 2] ), lo = H9_HexValue( id[i * 2 + 1] );

		if( hi < 0 || lo < 0 )
			return false;
		device[i] = (uint8_t)( hi * 16 + lo );
	}
	return true;
}

static void H9L_DeviceHash( char out[33] )
{
	uint8_t device[16], hash[32];
	h9sha_t s;

	out[0] = 0;
	if( !H9L_DeviceRead( device ))
		return;
	H9Sha_Init( &s );
	H9Sha_Update( &s, (const uint8_t *)"h9device1:", 10 );
	H9Sha_Update( &s, device, 16 );
	H9Sha_Final( &s, hash );
	H9_ToHex( hash, 16, out );
	memset( device, 0, sizeof( device ));
}

/*
=================
H9L_Load

user_id.ini read: the record this Windows user can open, a plain id= line, the records of others;
whatever needs it is written back
=================
*/
static void H9L_Load( void )
{
	static char text[H9L_FILE_MAX + 1];
	char path[MAX_SYSPATH], bak[MAX_SYSPATH], plain[33] = "", *line, *next;
	h9l_record_t rec;
	qboolean found = false, dirty = false, plain_line = false, bad_plain = false, have_file = false;
	FILE *f;
	size_t n = 0;

	memset( &rec, 0, sizeof( rec ));
	h9l.numothers = 0;

	if( !H9L_Path( path, sizeof( path ), "user_id.ini" ))
	{
		Con_Printf( S_ERROR "no root folder: this game has no id\n" );
		return;
	}

	f = fopen( path, "rb" );
	if( f )
	{
		n = fread( text, 1, H9L_FILE_MAX, f );
		fclose( f );
		have_file = true;
	}
	text[n] = 0;

	{
		qboolean client = false;

		for( line = text; have_file && line && *line; line = next )
		{
			const char *value;
			char *key;

			next = Q_strchr( line, '\n' );
			if( next )
				*next++ = 0;
			if( line == text && (byte)line[0] == 0xef && (byte)line[1] == 0xbb && (byte)line[2] == 0xbf )
				line += 3; // a byte order mark, as Notepad may leave
			while( *line == ' ' || *line == '\t' )
				line++;
			if( *line == ';' || *line == '#' || *line == '\r' || !*line )
				continue;
			if( *line == '[' )
			{
				client = !Q_strnicmp( line, "[client]", 8 );
				continue;
			}
			if( !client || !( value = H9L_KeyValue( line, &key )))
				continue;

			if( !Q_stricmp( key, "id" ))
			{
				if( !plain_line )
				{
					plain_line = true;
					if( !H9L_IdOf( value, plain ))
						bad_plain = true;
				}
			}
			else if( !Q_stricmp( key, "protected" ))
			{
				h9l_record_t r;

				if( H9L_Open( value, &r ))
				{
					if( !found )
					{
						rec = r;
						found = true;
					}
					else dirty = true; // a second record of this user's: dropped
					memset( &r, 0, sizeof( r ));
				}
				else if( h9l.numothers < H9L_OTHERS && H9L_IsBlob( value ))
					Q_strncpy( h9l.others[h9l.numothers++], value, sizeof( h9l.others[0] ));
				else dirty = true; // not a record anyone could open: dropped
			}
		}
	}
	memset( text, 0, sizeof( text ));

	if( plain_line )
	{
		dirty = true; // the plain line goes, whatever it held
		if( bad_plain )
			Con_Printf( S_WARN "user_id.ini's id= line is not an id of 32 hex characters: left out\n" );
		else
		{
			if( !found || Q_strcmp( rec.id, plain ))
			{
				if( found && H9L_Linked( &rec ) && Q_strcmp( rec.linked, plain ))
					Con_Printf( "H9 LINK: user_id.ini names another id: this game is no longer linked to %s\n", rec.account );
				Q_strncpy( rec.id, plain, sizeof( rec.id ));
				if( Q_strcmp( rec.linked, plain ))
					H9L_ClearLink( &rec );
			}
			found = true;

			// an older id, in plain text, from enter_userid.cmd
			if( H9L_Path( bak, sizeof( bak ), "user_id.ini.bak" ) && remove( bak ) == 0 )
				Con_Printf( "H9 LINK: removed user_id.ini.bak (an older id in plain text)\n" );
		}
	}
	if( !found )
	{
		if( h9l.numothers )
			Con_Printf( "H9 LINK: user_id.ini holds no id this Windows user can read (copied from another PC or user?): a new id\n" );
		H9L_NewId( rec.id );
		dirty = true;
	}

	memset( &h9l.rec, 0, sizeof( h9l.rec ));
	h9l.rec = rec;
	memset( &rec, 0, sizeof( rec ));
	h9l.loaded = true;

	if( dirty && !H9L_Write( ))
		Con_Printf( S_WARN "user_id.ini could not be written: this id holds for this session\n" );
	else if( !dirty )
		H9L_NoteFile( path );

	H9L_Apply();
}

#ifndef H9_LINK_SELFTEST

// while the main menu is up and no server is connected: a deleted or changed user_id.ini is read again
static void H9L_WatchFile( void )
{
	char path[MAX_SYSPATH];
	struct _stat64 st;
	qboolean exists;

	if( host.realtime < h9l.next_file_check )
		return;
	h9l.next_file_check = host.realtime + H9L_FILE_CHECK;
	if( cls.key_dest != key_menu || cls.state != ca_disconnected || h9l.flow == H9LF_ASKING || h9l.flow == H9LF_WAITING )
		return;
	if( !H9L_Path( path, sizeof( path ), "user_id.ini" ))
		return;
	exists = _stat64( path, &st ) == 0;
	if( exists == h9l.file_exists && ( !exists || ( st.st_mtime == h9l.file_mtime && st.st_size == h9l.file_size )))
		return;
	Con_Printf( "H9 LINK: user_id.ini %s: reading it again\n", exists ? "changed" : "is gone" );
	H9L_Load();
}

/*
==============================================================================

	TALKING TO HAVOC9.ORG

==============================================================================
*/

// the site cl_h9_site points to now, canonical: a local test site, or havoc9.org
static const char *H9L_Site( void )
{
	static char site[64];
	convar_t *cv = Cvar_FindVar( "cl_h9_site" );

	return cv && H9L_SiteOf( cv->string, site, sizeof( site )) == 1 ? site : H9L_SITE;
}

// a request to the given site: havoc9.org over https with its certificate checked, to a public
// address only; a local test site as it is
static qboolean H9L_GetAt( const char *site, const char *path, http_memory_cb_t cb, int tag )
{
	char url[512];
	const int flags = H9L_LocalSite( site ) ? 0 : ( HTTP_MEM_PUBLIC_ONLY | HTTP_MEM_VERIFY_TLS );

	if( !H9L_IsSite( site ))
		return false;
	Q_snprintf( url, sizeof( url ), "%s%s", site, path );
	return HTTP_GetToMemoryEx( url, cb, (void *)(intptr_t)tag, flags );
}

static void H9L_SetText( const char *fmt, ... ) FORMAT_CHECK( 1 );
static void H9L_SetText( const char *fmt, ... )
{
	va_list args;

	va_start( args, fmt );
	Q_vsnprintf( h9l.text, sizeof( h9l.text ), fmt, args );
	va_end( args );
	Cvar_DirectFullSet( &cl_h9link_text, h9l.text, 0 );
}

static void H9L_SetFlow( int flow )
{
	char n[8];

	h9l.flow = flow;
	Q_snprintf( n, sizeof( n ), "%d", flow );
	Cvar_DirectFullSet( &cl_h9link_flow, n, 0 );
	Cvar_DirectFullSet( &cl_h9link_code, flow == H9LF_WAITING ? h9l.user_code : "", 0 );
	if( flow == H9LF_LINKED || flow == H9LF_FAILED )
		h9l.notice_until = host.realtime + H9L_NOTICE;
	if( flow != H9LF_WAITING )
		h9l.panel_up = false;
}

static void H9L_Fail( const char *why )
{
	char text[160];

	Q_strncpy( text, why, sizeof( text )); // why may be va()'s, which the calls below reuse
	h9l.generation++;
	h9l.asking = false;
	h9l.device_code[0] = 0;
	H9L_SetText( "%s", text );
	H9L_SetFlow( H9LF_FAILED );
	Con_Printf( "H9 LINK: %s\n", text );
}

static void H9L_TimeText( void )
{
	int left = (int)( h9l.expires_at - host.realtime + 0.999 );

	if( left < 0 )
		left = 0;
	if( left == h9l.shown_seconds )
		return;
	h9l.shown_seconds = left;
	H9L_SetText( "Waiting for you to approve it on %s/link: %d:%02d left.", H9L_SiteName( h9l.flow_site ), left / 60, left % 60 );
}

static void H9L_StartAnswer( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	char body[1024], status[32], code[16], device[48], num[16];
	int expires;

	if( (int)(intptr_t)userdata != h9l.generation || h9l.flow != H9LF_ASKING )
		return;
	h9l.asking = false;

	if( !H9L_Body( success, data, size, body, sizeof( body )) || !H9L_Json( body, "status", status, sizeof( status )))
	{
		H9L_Fail( va( "%s did not answer. Check your connection, then try again.", H9L_SiteName( h9l.flow_site )));
		return;
	}
	if( !Q_strcmp( status, "busy" ))
	{
		H9L_Fail( va( "%s is busy just now: try again in a few minutes.", H9L_SiteName( h9l.flow_site )));
		return;
	}
	if( Q_strcmp( status, "ok" ) || !H9L_Json( body, "userCode", code, sizeof( code )) || !H9L_IsUserCode( code )
		|| !H9L_Json( body, "deviceCode", device, sizeof( device )) || !H9L_IsToken( device ))
	{
		H9L_Fail( va( "%s gave an answer this game does not understand: update H9XASH.", H9L_SiteName( h9l.flow_site )));
		return;
	}

	Q_strncpy( h9l.user_code, code, sizeof( h9l.user_code ));
	Q_strncpy( h9l.device_code, device, sizeof( h9l.device_code ));
	h9l.interval = H9L_Json( body, "interval", num, sizeof( num )) ? Q_atoi( num ) : 5;
	h9l.interval = bound( 2, h9l.interval, 60 );
	expires = H9L_Json( body, "expiresIn", num, sizeof( num )) ? Q_atoi( num ) : 600;
	h9l.expires_at = host.realtime + bound( 60, expires, 1800 );
	h9l.next_poll_at = host.realtime + h9l.interval;
	h9l.poll_failures = 0;
	h9l.shown_seconds = -1;
	H9L_SetFlow( H9LF_WAITING );
	H9L_TimeText();

	Con_Printf( "H9 LINK: your code is %s. Open %s/link/ (h9_link open opens it), sign in and approve it.\n", h9l.user_code, h9l.flow_site );

	// in a game, the panel comes up; keys and buttons held as it does are let go
	if( cls.state == ca_active && cls.key_dest == key_game )
	{
		Key_ClearStates();
		memset( h9l.eat, 0, sizeof( h9l.eat ));
		h9l.panel_up = true;
	}
}

static void H9L_Linked_Now( const char *player_id, const char *account, const char *token, const char *site )
{
	memset( &h9l.rec, 0, sizeof( h9l.rec ));
	Q_strncpy( h9l.rec.id, player_id, sizeof( h9l.rec.id ));
	Q_strncpy( h9l.rec.linked, player_id, sizeof( h9l.rec.linked ));
	Q_strncpy( h9l.rec.account, account, sizeof( h9l.rec.account ));
	Q_strncpy( h9l.rec.token, token, sizeof( h9l.rec.token ));
	Q_strncpy( h9l.rec.site, site, sizeof( h9l.rec.site ));
	if( !H9L_Write( ))
		Con_Printf( S_WARN "user_id.ini could not be written: the link holds for this session only\n" );
	H9L_Apply();
	H9L_Resalt();
	h9l.status_done = true; // nothing to ask this session: the link is new
}

static void H9L_PollAnswer( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	char body[1024], status[32], id[40], player[33], account[32], token[48], num[16];

	if( (int)(intptr_t)userdata != h9l.generation || h9l.flow != H9LF_WAITING )
		return;
	h9l.asking = false;

	if( !H9L_Body( success, data, size, body, sizeof( body )) || !H9L_Json( body, "status", status, sizeof( status )))
	{
		if( ++h9l.poll_failures > H9L_POLL_FAILURES )
			H9L_Fail( va( "Lost touch with %s. Check your connection, then link again.", H9L_SiteName( h9l.flow_site )));
		else h9l.next_poll_at = host.realtime + h9l.interval * 2;
		return;
	}
	h9l.poll_failures = 0;
	h9l.next_poll_at = host.realtime + h9l.interval;

	if( !Q_strcmp( status, "pending" ))
		return;
	if( !Q_strcmp( status, "slow_down" ))
	{
		int n = H9L_Json( body, "interval", num, sizeof( num )) ? Q_atoi( num ) : h9l.interval + 5;

		h9l.interval = bound( h9l.interval + 1, n, 120 );
		h9l.next_poll_at = host.realtime + h9l.interval;
		return;
	}
	if( !Q_strcmp( status, "denied" ))
	{
		H9L_Fail( va( "The link was turned down on %s.", H9L_SiteName( h9l.flow_site )));
		return;
	}
	if( !Q_strcmp( status, "approved" ) && H9L_Json( body, "playerId", id, sizeof( id )) && H9L_IdOf( id, player )
		&& H9L_Json( body, "account", account, sizeof( account )) && H9L_IsAccount( account )
		&& H9L_Json( body, "token", token, sizeof( token )) && H9L_IsToken( token ))
	{
		h9l.generation++;
		h9l.device_code[0] = 0;
		H9L_Linked_Now( player, account, token, h9l.flow_site );
		memset( body, 0, sizeof( body ));
		memset( player, 0, sizeof( player ));
		memset( id, 0, sizeof( id ));
		H9L_SetText( "Linked to %s account %s: this game plays as your account now.", H9L_SiteName( h9l.flow_site ), account );
		H9L_SetFlow( H9LF_LINKED );
		Con_Printf( "H9 LINK: linked to %s account %s. This game plays as your account now.\n", H9L_SiteName( h9l.flow_site ), account );
		return;
	}
	if( !Q_strcmp( status, "expired" ))
	{
		H9L_Fail( "The code ran out, or was used already. Link again for a new one." );
		return;
	}
	H9L_Fail( va( "%s gave an answer this game does not understand: update H9XASH.", H9L_SiteName( h9l.flow_site )));
}

static qboolean H9L_UnderWine( void )
{
	HMODULE ntdll = GetModuleHandleA( "ntdll.dll" );

	return ntdll && GetProcAddress( ntdll, "wine_get_version" ) ? true : false;
}

static void H9L_Start( void )
{
	char path[128], device[33];

	H9L_DeviceHash( device );
	h9l.generation++;
	Q_snprintf( path, sizeof( path ), "/api/link/start?v=1&device=%s&os=%s", device, H9L_UnderWine( ) ? "wine" : "windows" );
	h9l.user_code[0] = h9l.device_code[0] = 0;
	Q_strncpy( h9l.flow_site, H9L_Site( ), sizeof( h9l.flow_site ));
	Cvar_DirectFullSet( &cl_h9link_site, H9L_SiteName( h9l.flow_site ), 0 );
	H9L_SetText( "Asking %s for a code...", H9L_SiteName( h9l.flow_site ));
	H9L_SetFlow( H9LF_ASKING );
	h9l.asking = true;
	if( !H9L_GetAt( h9l.flow_site, path, H9L_StartAnswer, h9l.generation ))
		H9L_Fail( va( "This game could not reach %s.", H9L_SiteName( h9l.flow_site )));
}

static void H9L_Ignore( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
}

// the link gone here: a new random id, written and set (h9_unlink, or the link's site says it is gone)
static void H9L_DropLink( void )
{
	memset( &h9l.rec, 0, sizeof( h9l.rec ));
	H9L_NewId( h9l.rec.id );
	if( !H9L_Write( ))
		Con_Printf( S_WARN "user_id.ini could not be written: the new id holds for this session only\n" );
	H9L_Apply();
	H9L_Resalt();
}

static void H9L_StatusAnswer( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	char body[512], status[32], account[32];

	if( !H9L_Body( success, data, size, body, sizeof( body )) || !H9L_Json( body, "status", status, sizeof( status )))
		return; // no answer: the link stands
	if( !H9L_Linked( &h9l.rec ) || Q_strcmp( h9l.rec.token, h9l.status_token ))
		return; // linked again, or unlinked, while it asked
	if( !url || Q_strncmp( url, h9l.rec.site, Q_strlen( h9l.rec.site )) || url[Q_strlen( h9l.rec.site )] != '/' )
		return; // only the link's own site can end it

	if( !Q_strcmp( status, "unlinked" ))
	{
		Con_Printf( "H9 LINK: %s no longer lists this game as linked to %s (REVOKE on the ACCOUNT page, or the account's player id was reset). "
			"It has a new id; link it again from the main menu.\n", H9L_SiteName( h9l.rec.site ), h9l.rec.account );
		H9L_DropLink();
		if( h9l.flow == H9LF_LINKED )
			H9L_SetFlow( H9LF_IDLE );
	}
	else if( !Q_strcmp( status, "linked" ) && H9L_Json( body, "account", account, sizeof( account )) && H9L_IsAccount( account ) && Q_strcmp( account, h9l.rec.account ))
	{
		// the account was renamed
		Q_strncpy( h9l.rec.account, account, sizeof( h9l.rec.account ));
		H9L_Write( );
		H9L_Apply( );
	}
}

// a try that got no answer: again in a minute, while the menu is up
static void H9L_AdoptLater( void )
{
	h9l.adopt_asking = false;
	h9l.adopt_next = host.realtime + 60.0;
}

static void H9L_AdoptAnswer( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	char body[512], status[32], account[32], token[48], reason[32];

	if( (int)(intptr_t)userdata != h9l.adopt_gen || !h9l.adopt_asking )
		return;
	if( !H9L_Body( success, data, size, body, sizeof( body )) || !H9L_Json( body, "status", status, sizeof( status )))
	{
		H9L_AdoptLater();
		return;
	}
	h9l.adopt_asking = false;

	if( !Q_strcmp( status, "linked" ) && H9L_Json( body, "account", account, sizeof( account )) && H9L_IsAccount( account )
		&& H9L_Json( body, "token", token, sizeof( token )) && H9L_IsToken( token ))
	{
		h9l.adopt_done = true;
		if( H9L_Linked( &h9l.rec ) || Q_strcmp( h9l.rec.id, h9l.adopt_id ))
			return; // linked or changed meanwhile
		Q_strncpy( h9l.rec.linked, h9l.rec.id, sizeof( h9l.rec.linked ));
		Q_strncpy( h9l.rec.account, account, sizeof( h9l.rec.account ));
		Q_strncpy( h9l.rec.token, token, sizeof( h9l.rec.token ));
		Q_strncpy( h9l.rec.site, h9l.adopt_site, sizeof( h9l.rec.site ));
		if( !H9L_Write( ))
			Con_Printf( S_WARN "user_id.ini could not be written: the link holds for this session only\n" );
		H9L_Apply();
		h9l.status_done = true; // nothing to ask this session: the link is new
		Con_Printf( "H9 LINK: this game's id is %s account %s's: the game is linked to it\n", H9L_SiteName( h9l.adopt_site ), account );
		return;
	}
	if( !Q_strcmp( status, "unknown" ))
	{
		h9l.adopt_done = true; // an id of this install's own: nothing to say
		return;
	}
	if( !Q_strcmp( status, "refused" ) && H9L_Json( body, "reason", reason, sizeof( reason )) && Q_strcmp( reason, "stale" ))
	{
		h9l.adopt_done = true;
		if( !Q_strcmp( reason, "second_device" ))
			Con_Printf( "H9 LINK: this game's id is an account's on %s, but its id is bound to another device there: an admin may allow this one\n", H9L_SiteName( h9l.adopt_site ));
		else if( !Q_strcmp( reason, "suspended" ))
			Con_Printf( "H9 LINK: this game's id is a suspended account's on %s: not linked\n", H9L_SiteName( h9l.adopt_site ));
		else Con_Printf( "H9 LINK: %s did not take this game's proof of its id (%s): not linked\n", H9L_SiteName( h9l.adopt_site ), reason );
		return;
	}
	H9L_AdoptLater(); // busy, a used nonce, or an answer this game does not know
}

static void H9L_AdoptNonceAnswer( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	char body[256], status[32], nonce[40], key[33], devmask[33], proof[65], path[384];
	uint8_t device[16], mac[32];

	if( (int)(intptr_t)userdata != h9l.adopt_gen || !h9l.adopt_asking )
		return;
	if( !H9L_Body( success, data, size, body, sizeof( body )) || !H9L_Json( body, "status", status, sizeof( status ))
		|| Q_strcmp( status, "ok" ) || !H9L_Json( body, "nonce", nonce, sizeof( nonce )) || !H9_IsHex( nonce, 32 ))
	{
		H9L_AdoptLater();
		return;
	}
	if( H9L_Linked( &h9l.rec ) || !H9_IsHex( h9l.rec.id, 32 ) || !H9L_DeviceRead( device ))
	{
		h9l.adopt_asking = false;
		h9l.adopt_done = true;
		return;
	}

	H9_HmacSha256( (const uint8_t *)h9l.rec.id, 32, (const uint8_t *)"h9adopt-key1", 12, mac );
	H9_ToHex( mac, 16, key );
	H9_IdProof( h9l.rec.id, device, nonce, "h9link-adopt", devmask, proof );
	memset( device, 0, sizeof( device ));
	memset( mac, 0, sizeof( mac ));
	Q_strncpy( h9l.adopt_id, h9l.rec.id, sizeof( h9l.adopt_id ));

	Q_snprintf( path, sizeof( path ), "/api/link/adopt?v=1&key=%s&nonce=%s&devmask=%s&proof=%s&os=%s",
		key, nonce, devmask, proof, H9L_UnderWine( ) ? "wine" : "windows" );
	if( !H9L_GetAt( h9l.adopt_site, path, H9L_AdoptAnswer, h9l.adopt_gen ))
		H9L_AdoptLater();
}

static void H9L_AdoptStart( void )
{
	uint8_t device[16];

	h9l.adopt_started = true;
	if( !H9L_DeviceRead( device ))
	{
		h9l.adopt_done = true; // no device id: no proof to make
		return;
	}
	memset( device, 0, sizeof( device ));
	Q_strncpy( h9l.adopt_site, H9L_Site( ), sizeof( h9l.adopt_site ));
	h9l.adopt_asking = true;
	h9l.adopt_gen++;
	if( !H9L_GetAt( h9l.adopt_site, "/api/link/adopt/nonce?v=1", H9L_AdoptNonceAnswer, h9l.adopt_gen ))
		H9L_AdoptLater();
}

/*
==============================================================================

	THE COMMANDS

==============================================================================
*/

/*
=================
H9L_Link_f

h9_link [open|cancel]
=================
*/
static void H9L_Link_f( void )
{
	const qboolean mine = Cmd_CurrentCommandIsPrivileged();
	const char *arg = Cmd_Argc() > 1 ? Cmd_Argv( 1 ) : "";

	if( !h9l.loaded )
	{
		Con_Printf( "H9 LINK: this game has no id store (user_id.ini) to link\n" );
		return;
	}

	if( arg[0] )
	{
		if( !mine )
			return; // opening the browser and dropping the code are the player's alone

		if( !Q_stricmp( arg, "open" ))
		{
			char url[256];

			if( h9l.flow != H9LF_WAITING )
			{
				Con_Printf( "H9 LINK: no code is up: h9_link first\n" );
				return;
			}
			Q_snprintf( url, sizeof( url ), "%s/link/?code=%s", h9l.flow_site, h9l.user_code );
			Con_Printf( "H9 LINK: opening %s in the web browser\n", url );
			Platform_ShellExecute( url, NULL );
			h9l.panel_up = false;
		}
		else if( !Q_stricmp( arg, "cancel" ))
		{
			if( h9l.flow == H9LF_ASKING || h9l.flow == H9LF_WAITING )
				Con_Printf( "H9 LINK: the code is dropped\n" );
			h9l.generation++;
			h9l.asking = false;
			h9l.device_code[0] = 0;
			H9L_SetText( "%s", "" );
			H9L_SetFlow( H9LF_IDLE );
		}
		else Con_Printf( S_USAGE "h9_link [open|cancel]\n" );
		return;
	}

	if( H9L_Linked( &h9l.rec ))
	{
		Con_Printf( "H9 LINK: this game is linked to %s account %s already. Unlink it first (Unlink your Account in the main menu, or h9_unlink).\n", H9L_SiteName( h9l.rec.site ), h9l.rec.account );
		return;
	}

	// a code that is up already is shown again
	if( h9l.flow == H9LF_ASKING || h9l.flow == H9LF_WAITING )
	{
		if( h9l.flow == H9LF_WAITING )
		{
			Con_Printf( "H9 LINK: your code is %s (h9_link open opens the page)\n", h9l.user_code );
			if( cls.state == ca_active && cls.key_dest == key_game )
			{
				Key_ClearStates();
				memset( h9l.eat, 0, sizeof( h9l.eat ));
				h9l.panel_up = true;
			}
		}
		return;
	}

	if( !mine )
	{
		int i, recent = 0;

		// a server's: only in a game, and only so often
		if( cls.state != ca_active || cls.demoplayback )
			return;
		for( i = 0; i < H9L_SERVER_BURST; i++ )
		{
			if( h9l.server_starts[i] > 0.0 && host.realtime - h9l.server_starts[i] < H9L_SERVER_WINDOW )
				recent++;
		}
		if( recent >= H9L_SERVER_BURST )
		{
			Con_Printf( "H9 LINK: the server asked for another code too soon: type h9_link in the console instead\n" );
			return;
		}
		h9l.server_starts[h9l.next_server_start] = host.realtime;
		h9l.next_server_start = ( h9l.next_server_start + 1 ) % H9L_SERVER_BURST;
	}

	H9L_Start();
}

/*
=================
H9L_Unlink_f

h9_unlink: the player's alone (a privileged command)
=================
*/
static void H9L_Unlink_f( void )
{
	char path[96], account[32], site[64];

	if( !h9l.loaded )
		return;
	if( !H9L_Linked( &h9l.rec ))
	{
		Con_Printf( "H9 LINK: this game is not linked to an account\n" );
		return;
	}

	// the link's own site is told, and whether it hears does not matter here
	Q_snprintf( path, sizeof( path ), "/api/link/unlink?token=%s", h9l.rec.token );
	H9L_GetAt( h9l.rec.site, path, H9L_Ignore, 0 );

	Q_strncpy( account, h9l.rec.account, sizeof( account ));
	Q_strncpy( site, h9l.rec.site, sizeof( site ));
	H9L_DropLink();
	if( h9l.flow == H9LF_LINKED )
		H9L_SetFlow( H9LF_IDLE );
	Con_Printf( "H9 LINK: this game is no longer linked to %s account %s. It has a new id.\n", H9L_SiteName( site ), account );
}

/*
==============================================================================

	THE PANEL IN A GAME (a panel of cl_motd.c's kind)

==============================================================================
*/

static qboolean H9L_Active( void )
{
	return h9l.panel_up && h9l.flow == H9LF_WAITING && cls.state == ca_active && cls.key_dest == key_game;
}

static void H9L_Open_Page( void )
{
	Cbuf_AddText( "h9_link open\n" );
	h9l.panel_up = false;
}

static qboolean H9L_KeyEvent( int key, qboolean down )
{
	if( key < 0 || key >= (int)ARRAYSIZE( h9l.eat ))
		return false;

	if( !down )
	{
		if( !h9l.eat[key] )
			return false;
		h9l.eat[key] = false;
		return true;
	}

	// the console stays within reach
	if( !H9L_Active( ) || key == '`' || key == '~' )
		return false;

	h9l.eat[key] = true;

	switch( key )
	{
	case 'o':
	case 'O':
	case K_ENTER:
	case K_KP_ENTER:
		H9L_Open_Page();
		break;
	case K_ESCAPE:
		h9l.panel_up = false;
		break;
	default:
		break;
	}
	return true;
}

static qboolean H9L_MouseEvent( int key, qboolean down )
{
	int mx, my;

	if( key < K_MOUSE1 || key > K_MOUSE5 )
		return false;

	if( !down )
	{
		if( !h9l.eat[key] )
			return false;
		h9l.eat[key] = false;
		return true;
	}

	if( !H9L_Active( ))
		return false;

	h9l.eat[key] = true;
	if( key != K_MOUSE1 )
		return true;

	Platform_GetMousePos( &mx, &my );
	if( H9UI_Hit( &h9l.btn[H9L_BTN_OPEN], mx, my ))
		H9L_Open_Page();
	else if( H9UI_Hit( &h9l.btn[H9L_BTN_CLOSE], mx, my ))
		h9l.panel_up = false;
	return true;
}

static void H9L_Frame( void )
{
	if( !h9l.loaded )
		return;

	H9L_WatchFile();

	// the site in use, said a moment after start (configs have run) and whenever cl_h9_site changes
	if( host.realtime - h9l.started_at > 2.0 )
	{
		convar_t *cv = Cvar_FindVar( "cl_h9_site" );
		const char *value = cv ? cv->string : "";

		if( !h9l.site_said || Q_strcmp( h9l.site_value, value ))
		{
			char site[64];
			const int kind = H9L_SiteOf( value, site, sizeof( site ));

			h9l.site_said = true;
			Q_strncpy( h9l.site_value, value, sizeof( h9l.site_value ));
			if( kind == 1 )
				Con_Printf( "H9 SITE: %s, the local test site cl_h9_site names\n", site );
			else if( kind == 0 )
				Con_Printf( "H9 SITE: %s\n", H9L_SITE );
			else if( kind == -2 )
				Con_Printf( "H9 SITE: cl_h9_site \"%s\" is cut short (the console takes // for a comment): write cl_h9_site 127.0.0.1:<port>. Using %s\n", value, H9L_SITE );
			else Con_Printf( "H9 SITE: cl_h9_site \"%s\" is not a local test site (127.0.0.1:<port> or localhost:<port>): using %s\n", value, H9L_SITE );
		}
	}

	// the site the menu names: the code's while one is up, else the link's, else cl_h9_site's
	if( h9l.flow != H9LF_ASKING && h9l.flow != H9LF_WAITING )
	{
		const char *name = H9L_SiteName( H9L_Linked( &h9l.rec ) ? h9l.rec.site : H9L_Site( ));

		if( Q_strcmp( cl_h9link_site.string, name ))
			Cvar_DirectFullSet( &cl_h9link_site, name, 0 );
	}

	// once a start: does the link still stand? Asked of the link's own site, while it is the site
	// cl_h9_site points to: a link made on the local test site is left alone on havoc9.org
	if( !h9l.status_done && host.realtime - h9l.started_at > H9L_STATUS_DELAY )
	{
		h9l.status_done = true;
		if( H9L_Linked( &h9l.rec ) && Q_strcmp( h9l.rec.site, H9L_Site( )))
		{
			Con_Printf( "H9 LINK: this game is linked on %s, and cl_h9_site points elsewhere: the link is kept, and not checked this time\n",
				H9L_SiteName( h9l.rec.site ));
		}
		else if( H9L_Linked( &h9l.rec ))
		{
			char path[96];

			Q_strncpy( h9l.status_token, h9l.rec.token, sizeof( h9l.status_token ));
			Q_snprintf( path, sizeof( path ), "/api/link/status?token=%s", h9l.rec.token );
			H9L_GetAt( h9l.rec.site, path, H9L_StatusAnswer, 0 );
		}
	}

	// a record with an id and no link asks whether its id is an account's: once a start, ten
	// seconds in, and while the main menu is up; once for each id and site, or again a minute after
	// a try that got no answer
	if( !H9L_Linked( &h9l.rec ) && h9l.flow != H9LF_ASKING && h9l.flow != H9LF_WAITING && !h9l.adopt_asking
		&& host.realtime - h9l.started_at > H9L_STATUS_DELAY && host.realtime >= h9l.adopt_next )
	{
		char want[128];

		Q_snprintf( want, sizeof( want ), "%s|%s", h9l.rec.id, H9L_Site( ));
		if( Q_strcmp( want, h9l.adopt_for ))
		{
			Q_strncpy( h9l.adopt_for, want, sizeof( h9l.adopt_for ));
			h9l.adopt_done = false;
		}
		if( !h9l.adopt_done && ( !h9l.adopt_started || cls.key_dest == key_menu ))
			H9L_AdoptStart();
	}

	if( h9l.flow != H9LF_WAITING )
		return;

	if( host.realtime >= h9l.expires_at )
	{
		H9L_Fail( "The code ran out. Link again for a new one." );
		return;
	}
	H9L_TimeText();

	if( !h9l.asking && host.realtime >= h9l.next_poll_at )
	{
		char path[96];

		Q_snprintf( path, sizeof( path ), "/api/link/poll?code=%s", h9l.device_code );
		h9l.asking = true;
		if( !H9L_GetAt( h9l.flow_site, path, H9L_PollAnswer, h9l.generation ))
		{
			h9l.asking = false;
			h9l.next_poll_at = host.realtime + h9l.interval;
		}
	}
}

// one line at the top of the screen: the code while it waits, a result for a few seconds
static void H9L_Notice( cl_font_t *font, const char *s )
{
	int W = refState.width, lh = font->charHeight, pad = Q_max( 4, lh / 3 );
	int w = Q_min( W - pad * 4, H9UI_Width( font, s, Q_strlen( s )) + pad * 2 );
	int x = ( W - w ) / 2, y = lh * 3;

	H9UI_Fill( x, y, w, lh + pad, 14, 8, 20, 220 );
	H9UI_Border( x, y, w, lh + pad, 1 );
	H9UI_Line( font, x + pad, y + pad / 2, w - pad * 2, s, h9ui_white );
}

static void H9L_Draw( void )
{
	char line[200];
	cl_font_t *font;
	int W, H, lh, pad, bh, pw, ph, px, py, y, mx, my, ow, cw;

	if( cls.state != ca_active || cls.key_dest != key_game )
		return;

	font = Con_GetCurFont();
	if( !font || !font->valid || font->charHeight <= 0 )
		return;

	if( !H9L_Active( ))
	{
		if( h9l.flow == H9LF_WAITING )
		{
			int left = Q_max( 0, (int)( h9l.expires_at - host.realtime + 0.999 ));

			Q_snprintf( line, sizeof( line ), "%s/link -- your code: %s (%d:%02d left). h9_link shows it again.", H9L_SiteName( h9l.flow_site ), h9l.user_code, left / 60, left % 60 );
			H9L_Notice( font, line );
		}
		else if(( h9l.flow == H9LF_LINKED || h9l.flow == H9LF_FAILED ) && host.realtime < h9l.notice_until )
			H9L_Notice( font, h9l.text );
		else return;

		ref.dllFuncs.Color4ub( 255, 255, 255, 255 );
		ref.dllFuncs.GL_SetRenderMode( kRenderNormal );
		return;
	}

	W = refState.width;
	H = refState.height;
	lh = font->charHeight;
	pad = Q_max( 6, lh / 2 );
	bh = lh + pad;
	pw = Q_min( W - pad * 4, H9UI_Width( font, "n", 1 ) * 66 + pad * 2 );
	ph = pad + lh * 8 + pad + bh + pad;
	px = ( W - pw ) / 2;
	py = ( H - ph ) / 3;

	memset( h9l.btn, 0, sizeof( h9l.btn ));
	Platform_GetMousePos( &mx, &my );

	H9UI_Fill( 0, 0, W, H, 0, 0, 0, 120 );
	H9UI_Fill( px, py, pw, ph, 14, 8, 20, 245 );
	H9UI_Border( px, py, pw, ph, Q_max( 1, lh / 12 ));

	y = py + pad;
	Q_snprintf( line, sizeof( line ), "Link this game to your account on %s", H9L_SiteName( h9l.flow_site ));
	H9UI_Line( font, px + pad, y, pw - pad * 2, line, h9ui_light );
	y += lh * 2;
	Q_snprintf( line, sizeof( line ), "Your code:   %s", h9l.user_code );
	H9UI_Line( font, px + pad, y, pw - pad * 2, line, h9ui_white );
	y += lh * 2;
	Q_snprintf( line, sizeof( line ), "1. OPEN PAGE opens %s/link in your web browser.", H9L_SiteName( h9l.flow_site ));
	H9UI_Line( font, px + pad, y, pw - pad * 2, line, h9ui_soft );
	y += lh;
	H9UI_Line( font, px + pad, y, pw - pad * 2, "2. Sign in there, and check that it shows this code.", h9ui_soft );
	y += lh;
	H9UI_Line( font, px + pad, y, pw - pad * 2, "3. Press LINK. This game then plays as your account.", h9ui_soft );
	y += lh;
	H9UI_Line( font, px + pad, y, pw - pad * 2, h9l.text, h9ui_soft );
	y += lh + pad;

	cw = H9UI_Width( font, "CLOSE (ESC)", 11 ) + pad * 2;
	ow = H9UI_Width( font, "OPEN PAGE (O)", 13 ) + pad * 2;
	H9UI_Button( font, &h9l.btn[H9L_BTN_CLOSE], px + pw - pad - cw, y, cw, bh, "CLOSE (ESC)", mx, my );
	H9UI_Button( font, &h9l.btn[H9L_BTN_OPEN], px + pw - pad - cw - pad - ow, y, ow, bh, "OPEN PAGE (O)", mx, my );

	if( !host.mouse_visible )
		H9UI_Cursor( mx, my, Q_max( 1, H / 540 ));

	ref.dllFuncs.Color4ub( 255, 255, 255, 255 );
	ref.dllFuncs.GL_SetRenderMode( kRenderNormal );
}

static void H9L_Reset( qboolean connection )
{
	// a new map or a disconnect takes the panel down; the code goes on waiting
	h9l.panel_up = false;
	memset( h9l.eat, 0, sizeof( h9l.eat ));
}

static const h9ui_panel_t h9l_panel =
{
	H9L_Active,
	H9L_KeyEvent,
	H9L_MouseEvent,
	H9L_Frame,
	H9L_Draw,
	H9L_Reset,
};

/*
==============
CL_H9Link_Init

after CL_InitLocal registered cl_h9_userid, before any config runs
==============
*/
void CL_H9Link_Init( void )
{
	Cvar_RegisterVariable( &cl_h9lnk );
	Cvar_RegisterVariable( &cl_h9link_account );
	Cvar_RegisterVariable( &cl_h9link_flow );
	Cvar_RegisterVariable( &cl_h9link_code );
	Cvar_RegisterVariable( &cl_h9link_text );
	Cvar_RegisterVariable( &cl_h9link_site );

	// not restricted: a server may send it (h9_link.sma's .link), and it only puts up a code
	Cmd_AddCommand( "h9_link", H9L_Link_f, "H9: link this game to your havoc9.org account (a code to approve on havoc9.org/link); h9_link open | cancel" );
	Cmd_AddRestrictedCommand( "h9_unlink", H9L_Unlink_f, "H9: unlink this game from its havoc9.org account; it gets a new id" );

	// the id is the store's: config.cfg no longer keeps it, and no config or console sets it
	ClearBits( cl_h9_userid.flags, FCVAR_ARCHIVE );
	SetBits( cl_h9_userid.flags, FCVAR_READ_ONLY );

	h9l.flow = H9LF_IDLE;
	h9l.started_at = host.realtime;
	H9L_Load();
	H9UI_AddPanel( &h9l_panel );
}

#endif // !H9_LINK_SELFTEST

#else // !XASH_WIN32 || XASH_EMSCRIPTEN

void CL_H9Link_Init( void )
{
}

#endif
