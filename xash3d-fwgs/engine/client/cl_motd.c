/*
cl_motd.c - H9: the splash MOTD, a server's picture or web page shown at join

A server running h9_motd.sma sends the H9Motd user message to each H9 client just before
the game's own MOTD (TS's "MOTD" user message, the text window). It comes in parts, as TS's
MOTD does: a byte, 1 on the last part, then a string. The parts make one info string:

	\v\1\type\image\show\connect\image\<address>\page\<address>\title\<name>[\asked\1]

	type   image: the splash is the picture. page: the splash is the web page.
	show   connect: once a connection. map: at every map.
	image  the picture: the splash itself for type image; for type page, what is shown
	       when the page itself cannot be (may be empty).
	page   the web page: the splash itself for type page; for type image, where the
	       OPEN PAGE button goes (may be empty).
	title  the panel's title: the server's name.
	asked  the player typed motd: it is shown again even when show is connect.

The engine takes H9Motd itself; the client library never sees it. While a splash is on its
way, the engine holds the TS MOTD parts that follow. A splash that shows drops them; one that
fails hands them to the client library as they came, so the player gets TS's text window,
exactly as on a server without a splash. A client without this code (stock TS, an older
H9XASH) has no handler for H9Motd, skips it and shows the text. With show connect and the
splash already shown this connection, the next maps show neither the splash nor the text.

The addresses must be https, with a host name (no IP address, no single-label name such
as localhost, none of the usual private names such as .local or .lan, no user name before the
host) and no spaces, quotes or backslashes. The host is always on screen.

Native build. A picture is fetched with the engine's HTTP client (HTTP_GetToMemoryEx: https
only, refused when no CA bundle is loaded, certificates checked against cacert.pem from
valve\extras.pk3; the host's resolved address must be public -- not loopback, private,
link-local, CGNAT, multicast or reserved -- and is the one connected to; no cookies, no
referrer), refused over H9M_MAX_BYTES, refused over H9M_MAX_SIDE pixels on a side before it is decoded
(its size is read from the file's header), decoded by imagelib (PNG, TGA, BMP) and drawn over
the HUD and VGUI.

A web page is shown inside the panel by h9webview.dll (xash3d-h9-patches\webview), which
hosts it with Microsoft Edge WebView2 in a child window over the panel's body, locked down
(h9webview.cpp lists how); the panel draws the title, "Web page at <host>" and CLOSE (ESC)
around it. The view is made hidden and shown once its page has loaded. When the page cannot
be shown here -- no h9webview.dll, no WebView2 runtime, exclusive full screen (where the game
minimizes as soon as another window takes the keyboard), Wine or Proton without
cl_h9_motd_wine, a page that fails or has not loaded within H9M_WAIT seconds, a view that
stops later -- the panel is the fallback: one line saying so, the page's picture when the
server gave one, else the held TS MOTD's text, and OPEN PAGE. The reason goes to the console.

OPEN PAGE, and any new window the page asks for, go through the confirm box: the whole
address on screen, and the system browser opens only on a mouse click on OPEN IN BROWSER,
never on a key. While the panel is up it has the keyboard (the console key excepted) and the
mouse; ESC or CLOSE end it, ENTER and SPACE too when no page is on screen, and the game gets
its mouse back. A page the player has clicked into has the keyboard itself; ESC there closes
the splash too.

Browser build: the page (havoc9.org\webclient\client.js, Module.motd) shows the splash in
its own overlay, the picture as an image and the page in a sandboxed frame, and answers
with h9_motd_result: 1 shown, 0 not shown (the text is handed on).

cl_h9_motd 0 (kept in config.cfg) turns it off for this player: TS's text MOTD as it comes.
cl_h9_motd_wine (Windows build under Wine or Proton): 1 shows web pages there too, without
Chromium's sandbox, 2 also with the GPU off. docs\H9_MOTD.txt has the whole picture.
*/

#include "common.h"
#include "client.h"
#include "const.h"
#include "keydefs.h"
#include "platform/platform.h"
#include "cl_motd.h"
#if XASH_EMSCRIPTEN
#include <emscripten.h>
#endif
#if XASH_WIN32
#include <wchar.h>
#endif

#define H9M_MAX_URL     256      // an address, its terminator included
#define H9M_MAX_HOST    128
#define H9M_MAX_TITLE   64
#define H9M_MAX_INFO    1024     // the whole H9Motd info string
#define H9M_MAX_BYTES   ( 2 * 1024 * 1024 ) // the largest picture file
#define H9M_MAX_SIDE    2048     // the largest picture side in pixels, checked before decoding
#define H9M_HELD_MAX    4096     // TS's MOTD parts held while a splash loads (TS sends 1536 characters at most)
#define H9M_TEXT_MAX    2048
#define H9M_WAIT        10.0     // seconds a splash may take to arrive before the text is shown instead
#define H9M_TEXT_WAIT   2.0      // seconds a page's text stand-in waits for TS's MOTD

static CVAR_DEFINE_AUTO( cl_h9_motd, "1", FCVAR_ARCHIVE | FCVAR_PRIVILEGED, "H9: show a server's splash MOTD (a picture or a web page) in place of its text MOTD: 1 = on, 0 = the text MOTD" );

typedef enum
{
	H9M_IDLE = 0,
	H9M_FETCH,     // native: the picture is on its way
	H9M_PAGE,      // native: the web page is loading in its view, its picture (if any) on its way
	H9M_TEXT,      // native: a page shown by its text, waiting for TS's text to arrive
	H9M_OPEN,      // native: the panel is up
	H9M_WEB_ASK,   // browser: to be handed to the page once the game is up
	H9M_WEB_WAIT,  // browser: the page has it; its answer is awaited
	H9M_WEB_OPEN,  // browser: the page shows it
} h9m_state_t;

typedef enum
{
	H9M_TEXT_PASS = 0, // TS's MOTD goes to the client library as it comes
	H9M_TEXT_HOLD,     // held until the splash shows or fails
	H9M_TEXT_DROP,     // dropped up to its last part
} h9m_textfate_t;

typedef enum
{
	H9M_PIC_NONE = 0,
	H9M_PIC_LOADING,
	H9M_PIC_READY,
	H9M_PIC_FAILED,
} h9m_picture_t;

enum
{
	H9M_BTN_CLOSE = 0,
	H9M_BTN_OPEN,
	H9M_BTN_GO,
	H9M_BTN_CANCEL,
	H9M_BTN_DIALOG,
	H9M_BTN_COUNT
};

static struct
{
	// H9Motd as its parts arrive
	char     info[H9M_MAX_INFO];
	size_t   infolen;
	qboolean infobad;

	// the splash
	h9m_state_t state;
	qboolean is_page;
	char     image[H9M_MAX_URL];
	char     image_host[H9M_MAX_HOST];
	char     page[H9M_MAX_URL];
	char     page_host[H9M_MAX_HOST];
	char     title[H9M_MAX_TITLE];
	double   started;
	int      gen;      // the current picture request; an answer for an older one is dropped
	h9m_picture_t picture;
	int      texture;
	int      picw, pich;

	// the page's view (Windows, h9webview.dll)
	void    *view;
	void    *view_window;  // the game window it was made in
	int      viewgen;      // the current view; a report from an older one is dropped
	qboolean view_tried;
	qboolean view_ready;   // its page has loaded
	qboolean view_failed;  // it cannot be shown here, or stopped
	qboolean view_escape;  // ESC was pressed in it
	qboolean view_lost;    // it reported that it cannot show the page; view_why says why
	char     view_why[128];
	char     view_host[H9M_MAX_HOST]; // the host its page is at now
	char     newwin[H9M_MAX_URL];     // a new window it asked for, for the confirm box
	int      view_x, view_y, view_w, view_h; // the panel's body, in render coordinates
	qboolean view_placed;

	// TS's MOTD, while the splash decides its fate
	h9m_textfate_t textfate;
	byte     held[H9M_HELD_MAX]; // each part: its size (2 bytes, low first), then its bytes
	size_t   heldlen;
	char     text[H9M_TEXT_MAX]; // its text, for a page shown by its text
	qboolean text_done;

	// the panel
	qboolean confirm;  // an address is up for a second click
	char     confirm_url[H9M_MAX_URL];
	char     confirm_host[H9M_MAX_HOST];
	int      scroll, lines, visible; // the text, in lines
	h9ui_rect_t btn[H9M_BTN_COUNT];
	byte     eat[256]; // keys and buttons the splash took: their releases are its too
	qboolean took_mouse;

	// this connection
	qboolean shown;
} motd;

// Other engine-drawn panels (cl_travel.c registers its prompt): each comes before the splash for
// the keys and the mouse, and is drawn above it.
#define H9UI_MAX_PANELS 8
static const h9ui_panel_t *h9ui_panels[H9UI_MAX_PANELS];
static int h9ui_numpanels;

void H9UI_AddPanel( const h9ui_panel_t *panel )
{
	if( panel && h9ui_numpanels < H9UI_MAX_PANELS )
		h9ui_panels[h9ui_numpanels++] = panel;
}

// the server's name, as its ServerName message gave it at join: the server's own word
static char h9ui_server[64];

const char *H9UI_ServerName( void )
{
	return h9ui_server;
}

// ServerName carries one string (the hostname cvar); quotes, carets, backslashes and anything
// outside printable ASCII become spaces
static void H9UI_NoteServerName( const byte *buf, int size )
{
	int n = 0;

	for( int i = 0; i < size && buf[i] && n + 1 < (int)sizeof( h9ui_server ); i++ )
	{
		byte c = buf[i];

		h9ui_server[n++] = ( c < ' ' || c > '~' || c == '"' || c == '^' || c == '\\' ) ? ' ' : (char)c;
	}

	h9ui_server[n] = '\0';
}

// another panel is up in the game: it has the keys and the mouse
static qboolean H9UI_PanelUp( void )
{
	for( int i = 0; i < h9ui_numpanels; i++ )
	{
		if( h9ui_panels[i]->Active( ))
			return true;
	}

	return false;
}

// the splash itself is up in the game
static qboolean H9M_Up( void )
{
	return motd.state == H9M_OPEN && cls.state == ca_active && cls.key_dest == key_game;
}

#if XASH_EMSCRIPTEN
// The page shows the splash (Module.motd in client.js): show() takes it and answers true when
// it will put it up, hide() takes it down. The page then runs h9_motd_result.
EM_JS( int, H9M_PageShow, ( int is_page, const char *image, const char *page, const char *title ), {
	var motd = Module.motd;
	if( !motd || !motd.show )
		return 0;
	try {
		return motd.show({ type: is_page ? "page" : "image", image: UTF8ToString( image ), page: UTF8ToString( page ), title: UTF8ToString( title ) }) ? 1 : 0;
	} catch( e ) {
		return 0;
	}
});

EM_JS( void, H9M_PageHide, ( void ), {
	var motd = Module.motd;
	if( motd && motd.hide ) {
		try { motd.hide(); } catch( e ) { }
	}
});
#endif

#if XASH_WIN32
// h9webview.dll's interface, as xash3d-h9-patches\webview\h9webview.h has it: the same numbers,
// and H9WV_API_VERSION raised there and here with any change
#define H9WV_API_VERSION 1
#define H9WV_READY       1
#define H9WV_FAILED      2
#define H9WV_ESCAPE      3
#define H9WV_NEWWINDOW   4
#define H9WV_NAVIGATED   5
#define H9WV_BLOCKED     6
#define H9WV_NOSANDBOX   1
#define H9WV_NOGPU       2
#define H9WV_WINEFIX     4

typedef void ( *h9wv_status_fn )( int status, const char *detail, void *user );
typedef int ( *h9wv_api_fn )( void );
typedef int ( *h9wv_str_fn )( char *buf, int size );
typedef void *( *h9wv_open_fn )( void *parent, const char *url, int flags, h9wv_status_fn status, void *user, char *why, int whysize );
typedef void ( *h9wv_place_fn )( void *view, int x, int y, int w, int h, int render_w, int render_h, int visible );
typedef void ( *h9wv_close_fn )( void *view );

static struct
{
	qboolean      tried;
	qboolean      ok;
	qboolean      wine;   // the game runs under Wine or Proton
	char          why[96];
	h9wv_str_fn   Runtime;
	h9wv_open_fn  Open;
	h9wv_place_fn Place;
	h9wv_close_fn Close;
} h9wv;

static CVAR_DEFINE_AUTO( cl_h9_motd_wine, "0", FCVAR_ARCHIVE | FCVAR_PRIVILEGED, "H9: under Wine or Proton, show a server's web page inside the game with Edge WebView2, without Chromium's sandbox: 0 = no, its picture or text and OPEN PAGE; 1 = yes; 2 = yes, with the GPU off" );
#endif

/*
==============================================================================

	THE MESSAGE

==============================================================================
*/

// printable ASCII only; line breaks only where lines is set, else spaces
static void H9M_Append( char *dst, size_t size, const char *src, size_t srclen, qboolean lines )
{
	size_t n = Q_strlen( dst );

	for( size_t i = 0; i < srclen && src[i]; i++ )
	{
		char c = src[i];

		if( c == '\t' || ( c == '\n' && !lines ))
			c = ' ';

		if(!(( c >= ' ' && c < 127 ) || c == '\n' ))
			continue;

		if( n + 1 >= size )
			break;

		dst[n++] = c;
	}

	dst[n] = '\0';
}

// the value of key in an info string, refused (false) when it is longer than size allows;
// Info_ValueForKey stops at 127 characters, shorter than an address may be
static qboolean H9M_Value( const char *info, const char *key, char *out, size_t size )
{
	const char *s = info;
	size_t keylen = Q_strlen( key );

	out[0] = '\0';

	while( *s == '\\' )
	{
		const char *k = ++s;
		const char *v;
		size_t klen, vlen;

		while( *s && *s != '\\' )
			s++;

		klen = s - k;

		if( *s != '\\' )
			return false;

		v = ++s;

		while( *s && *s != '\\' )
			s++;

		vlen = s - v;

		if( klen == keylen && !Q_strncmp( k, key, klen ))
		{
			if( vlen >= size )
				return false;

			memcpy( out, v, vlen );
			out[vlen] = '\0';
			return true;
		}
	}

	return false;
}

// localhost's family and the usual names of private networks: no splash is fetched from them
static qboolean H9M_PrivateHost( const char *host )
{
	static const char *const tails[] =
	{
		".localhost", ".local", ".localdomain", ".lan", ".home", ".internal", ".intranet",
		".corp", ".home.arpa", ".private"
	};
	size_t len = Q_strlen( host );

	for( size_t i = 0; i < ARRAYSIZE( tails ); i++ )
	{
		size_t n = Q_strlen( tails[i] );

		if( len >= n && !Q_stricmp( host + len - n, tails[i] ))
			return true;
	}

	return false;
}

// An address the splash may use: https; a host name with a dot and a letter in it (no IP
// address, no single-label name such as localhost, no private name such as .local), made of
// letters, digits, dots and dashes (no user name before it, no IPv6 brackets); then an optional
// port; printable ASCII without spaces, quotes, backslashes or <>^`{|}; shorter than
// H9M_MAX_URL. need_path: a path must follow the host and no #fragment may follow it (the HTTP
// client sends the path as it is). host gets the host in lower case, to be shown.
static qboolean H9M_CheckURL( const char *url, qboolean need_path, char *host, size_t hostsize )
{
	size_t len = Q_strlen( url ), n = 0;
	qboolean letter = false;
	const char *a;

	host[0] = '\0';

	if( len <= 8 || len >= H9M_MAX_URL || Q_strnicmp( url, "https://", 8 ))
		return false;

	for( size_t i = 0; i < len; i++ )
	{
		byte c = (byte)url[i];

		if( c <= ' ' || c >= 127 || Q_strchr( "\"'\\<>^`{|}", (char)c ))
			return false;
	}

	for( a = url + 8; *a && *a != '/' && *a != '?' && *a != '#' && *a != ':'; a++ )
	{
		char c = *a;

		if( c >= 'A' && c <= 'Z' )
			c += 'a' - 'A';

		if( c >= 'a' && c <= 'z' )
			letter = true;
		else if(!(( c >= '0' && c <= '9' ) || c == '.' || c == '-' ) || n + 1 >= hostsize )
		{
			host[0] = '\0';
			return false;
		}

		host[n++] = c;
	}

	host[n] = '\0';

	if( *a == ':' )
	{
		int port = 0, digits = 0;

		for( a++; *a >= '0' && *a <= '9'; a++, digits++ )
		{
			port = port * 10 + ( *a - '0' );

			if( port > 65535 )
				break;
		}

		if( !digits || port < 1 || port > 65535 || ( *a && *a != '/' && *a != '?' && *a != '#' ))
		{
			host[0] = '\0';
			return false;
		}
	}

	if( !n || !letter || !Q_strchr( host, '.' ) || host[0] == '.' || host[n - 1] == '.' || Q_strstr( host, ".." )
		|| H9M_PrivateHost( host ))
	{
		host[0] = '\0';
		return false;
	}

	if( need_path && ( *a != '/' || Q_strchr( url, '#' )))
	{
		host[0] = '\0';
		return false;
	}

	return true;
}

#if XASH_WIN32
// the host of any address, for the panel's "Web page at" line: lower case, and anything that is
// not a letter, digit, dot or dash shown as ?
static void H9M_HostOf( const char *url, char *host, size_t size )
{
	const char *s = Q_strstr( url, "://" );
	size_t n = 0;

	host[0] = '\0';

	if( !s )
		return;

	for( s += 3; *s && *s != '/' && *s != '?' && *s != '#' && *s != ':' && n + 1 < size; s++ )
	{
		char c = *s;

		if( c >= 'A' && c <= 'Z' )
			c += 'a' - 'A';

		if(!(( c >= 'a' && c <= 'z' ) || ( c >= '0' && c <= '9' ) || c == '.' || c == '-' ))
			c = '?';

		host[n++] = c;
	}

	host[n] = '\0';
}
#endif

/*
==============================================================================

	TS'S TEXT MOTD

==============================================================================
*/

// what is held goes to the client library as it came, and so does whatever follows
static void H9M_PassText( void )
{
	size_t at = 0;

	motd.textfate = H9M_TEXT_PASS;

	while( at + 2 <= motd.heldlen )
	{
		int size = motd.held[at] | ( motd.held[at + 1] << 8 );

		at += 2;

		if( at + size > motd.heldlen )
			break;

		CL_DispatchUserMessage( "MOTD", size, motd.held + at );
		at += size;
	}

	motd.heldlen = 0;
}

// what is held is dropped, and so is the rest of it, up to its last part
static void H9M_DropText( void )
{
	motd.heldlen = 0;
	motd.textfate = motd.text_done ? H9M_TEXT_PASS : H9M_TEXT_DROP;
}

// one part of TS's MOTD (a byte, 1 on the last part, then a string): true when it is held or dropped
static qboolean H9M_TextPart( const byte *buf, int size )
{
	qboolean last = size > 0 && buf[0] != 0;

	switch( motd.textfate )
	{
	case H9M_TEXT_DROP:
		if( last )
			motd.textfate = H9M_TEXT_PASS;
		return true;
	case H9M_TEXT_HOLD:
		break;
	default:
		return false;
	}

	if( size < 0 || motd.heldlen + 2 + (size_t)size > sizeof( motd.held ))
	{
		// more than TS ever sends: what is held goes on, then this part
		H9M_PassText();
		return false;
	}

	motd.held[motd.heldlen++] = size & 0xff;
	motd.held[motd.heldlen++] = ( size >> 8 ) & 0xff;
	memcpy( motd.held + motd.heldlen, buf, size );
	motd.heldlen += size;

	if( size > 1 )
		H9M_Append( motd.text, sizeof( motd.text ), (const char *)buf + 1, size - 1, true );

	if( last )
		motd.text_done = true;

	return true;
}

/*
==============================================================================

	THE PAGE'S VIEW (Windows: h9webview.dll)

==============================================================================
*/

// the view goes; a report still on its way from it is for nobody
static void H9M_ViewClose( void )
{
#if XASH_WIN32
	if( motd.view )
	{
		motd.viewgen++;
		h9wv.Close( motd.view );
	}
#endif
	motd.view = NULL;
	motd.view_window = NULL;
	motd.view_placed = false;
}

#if !XASH_EMSCRIPTEN
// the page cannot be shown here: the reason goes to the console once, and the view goes
static void H9M_ViewFail( const char *why )
{
	if( !motd.view_failed )
	{
		motd.view_failed = true;
		Con_Printf( "H9 MOTD: the page could not be shown here: %s\n", why ? why : "no reason given" );
	}

	H9M_ViewClose();
}

#if XASH_WIN32
// h9webview.dll from the game's own folder, once a session
static qboolean H9WV_Load( void )
{
	wchar_t path[MAX_PATH];
	wchar_t *slash;
	DWORD n;
	HMODULE dll;
	h9wv_api_fn api;
	h9wv_str_fn wine;
	char version[64];

	if( h9wv.tried )
		return h9wv.ok;

	h9wv.tried = true;
	Q_strncpy( h9wv.why, "h9webview.dll is missing", sizeof( h9wv.why ));

	n = GetModuleFileNameW( NULL, path, MAX_PATH );

	if( !n || n >= MAX_PATH || !( slash = wcsrchr( path, L'\\' )) || ( slash - path ) + 15 >= MAX_PATH )
		return false;

	wcscpy( slash + 1, L"h9webview.dll" );
	dll = LoadLibraryExW( path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH );

	if( !dll )
		return false;

	api = (h9wv_api_fn)GetProcAddress( dll, "H9WV_ApiVersion" );
	wine = (h9wv_str_fn)GetProcAddress( dll, "H9WV_Wine" );
	h9wv.Runtime = (h9wv_str_fn)GetProcAddress( dll, "H9WV_Runtime" );
	h9wv.Open = (h9wv_open_fn)GetProcAddress( dll, "H9WV_Open" );
	h9wv.Place = (h9wv_place_fn)GetProcAddress( dll, "H9WV_Place" );
	h9wv.Close = (h9wv_close_fn)GetProcAddress( dll, "H9WV_Close" );

	if( !api || !wine || !h9wv.Runtime || !h9wv.Open || !h9wv.Place || !h9wv.Close || api() != H9WV_API_VERSION )
	{
		Q_strncpy( h9wv.why, "h9webview.dll is not the one this engine needs", sizeof( h9wv.why ));
		FreeLibrary( dll );
		return false;
	}

	h9wv.wine = wine( version, sizeof( version )) != 0;

	if( h9wv.wine )
		Con_Reportf( "H9 MOTD: running under Wine %s\n", version );

	h9wv.ok = true;
	return true;
}

static void *H9M_GameWindow( void )
{
	void *window = NULL;

	if( R_GetWindowHandle( &window, REF_WINDOW_TYPE_WIN32 ) != REF_WINDOW_TYPE_WIN32 )
		return NULL;

	return window;
}

// What the view says, in the middle of the game's message loop: only noted here; the frame acts on it.
static void H9M_ViewStatus( int status, const char *detail, void *user )
{
	char host[H9M_MAX_HOST];

	// a view already closed has a new number; a report may also come before H9WV_Open returns
	if( (int)(intptr_t)user != motd.viewgen )
		return;

	switch( status )
	{
	case H9WV_READY:
		motd.view_ready = true;
		break;
	case H9WV_FAILED:
		if( !motd.view_lost )
		{
			motd.view_lost = true;
			Q_strncpy( motd.view_why, detail ? detail : "no reason given", sizeof( motd.view_why ));
		}
		break;
	case H9WV_ESCAPE:
		motd.view_escape = true;
		break;
	case H9WV_NEWWINDOW:
		if( detail && H9M_CheckURL( detail, false, host, sizeof( host )))
			Q_strncpy( motd.newwin, detail, sizeof( motd.newwin ));
		else Con_Printf( "H9 MOTD: the page asked to open an address the splash may not use\n" );
		break;
	case H9WV_NAVIGATED:
		if( detail )
			H9M_HostOf( detail, motd.view_host, sizeof( motd.view_host ));
		break;
	case H9WV_BLOCKED:
		Con_Printf( "H9 MOTD: the page went to an address that is not allowed (https and a host name only): %s\n", detail ? detail : "" );
		break;
	default:
		break;
	}
}
#endif // XASH_WIN32

// the page's view, made hidden; or why it cannot be
static void H9M_ViewOpen( void )
{
	motd.view_tried = true;

#if XASH_WIN32
	{
		char why[128], version[96];
		void *window;
		int flags = 0;

		if( refState.window_mode == WINDOW_MODE_FULLSCREEN )
		{
			H9M_ViewFail( "the game is in exclusive full screen (fullscreen 1): fullscreen 2 or 0 shows it" );
			return;
		}

		if( !H9WV_Load( ))
		{
			H9M_ViewFail( h9wv.why );
			return;
		}

		if( h9wv.wine )
		{
			if( cl_h9_motd_wine.value <= 0.0f )
			{
				H9M_ViewFail( "web pages are not shown under Wine or Proton unless cl_h9_motd_wine is 1 (docs\\H9_MOTD.txt)" );
				return;
			}

			flags = H9WV_NOSANDBOX | H9WV_WINEFIX;

			if( cl_h9_motd_wine.value >= 2.0f )
				flags |= H9WV_NOGPU;
		}

		if( !h9wv.Runtime( version, sizeof( version )))
		{
			if( h9wv.wine )
				Con_Printf( "H9 MOTD: no WebView2 runtime in this Wine prefix: run Microsoft's WebView2 Evergreen Standalone Installer in it (wine MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install, see README_LINUX.txt), or put a Fixed Version runtime in H9XASH\\webview2\\runtime\n" );
			else Con_Printf( "H9 MOTD: the Microsoft Edge WebView2 Runtime is not installed: https://go.microsoft.com/fwlink/p/?LinkId=2124703\n" );

			H9M_ViewFail( "no WebView2 runtime" );
			return;
		}

		window = H9M_GameWindow();

		if( !window )
		{
			H9M_ViewFail( "no game window" );
			return;
		}

		motd.viewgen++;
		motd.view_window = window;
		motd.view = h9wv.Open( window, motd.page, flags, H9M_ViewStatus, (void *)(intptr_t)motd.viewgen, why, sizeof( why ));

		if( !motd.view )
		{
			H9M_ViewFail( why );
			return;
		}

		Con_Reportf( "H9 MOTD: loading %s with WebView2 %s\n", motd.page_host, version );
	}
#else
	H9M_ViewFail( "this build has no web view" );
#endif
}
#endif // !XASH_EMSCRIPTEN

// where the view sits and whether it shows: with its panel up, in the game, with no confirm box over it
static void H9M_ViewSync( void )
{
#if XASH_WIN32
	qboolean show;

	if( !motd.view )
		return;

	show = motd.state == H9M_OPEN && motd.view_ready && motd.view_placed && !motd.confirm && H9M_Up( ) && !H9UI_PanelUp( );
	h9wv.Place( motd.view, motd.view_x, motd.view_y, motd.view_w, motd.view_h, refState.width, refState.height, show );
#endif
}

/*
==============================================================================

	THE SPLASH

==============================================================================
*/

static void H9M_FreePicture( void )
{
	if( motd.texture && ref.initialized )
		ref.dllFuncs.GL_FreeTexture( motd.texture );

	motd.texture = 0;
	motd.picw = motd.pich = 0;
	motd.picture = H9M_PIC_NONE;
}

// the splash goes away; TS's text is left as it stands
static void H9M_Stop( void )
{
#if XASH_EMSCRIPTEN
	if( motd.state == H9M_WEB_WAIT || motd.state == H9M_WEB_OPEN )
		H9M_PageHide();
#endif
	H9M_ViewClose();
	motd.gen++; // a picture still on its way is for nobody
	H9M_FreePicture();
	motd.state = H9M_IDLE;
	motd.confirm = false;
	motd.scroll = 0;
	motd.view_tried = false;
	motd.view_ready = false;
	motd.view_failed = false;
	motd.view_escape = false;
	motd.view_lost = false;
	motd.view_why[0] = '\0';
	motd.view_host[0] = '\0';
	motd.newwin[0] = '\0';
}

// the splash cannot be shown: TS's text instead, as on a server without one
static void H9M_Fail( const char *why )
{
	Con_Printf( "H9 MOTD: %s; the server's text MOTD is shown instead\n", why );
	H9M_Stop();
	H9M_PassText();
}

// the splash is on screen: TS's text is not shown
static void H9M_Shown( h9m_state_t state )
{
	motd.state = state;
	motd.shown = true;
	H9M_DropText();
}

#if !XASH_EMSCRIPTEN
static int H9M_Side( uint v )
{
	return v > H9M_MAX_SIDE ? H9M_MAX_SIDE + 1 : (int)v;
}

// a picture's format and size from its header, before anything decodes it: PNG and BMP by their
// signatures, TGA (which has none) only when the address names a .tga file
static qboolean H9M_PictureSize( const byte *b, size_t size, const char **ext, int *w, int *h )
{
	static const byte png[8] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
	const char *path = Q_strchr( motd.image + 8, '/' );
	char tail[8];

	if( size >= 24 && !memcmp( b, png, sizeof( png )) && !memcmp( b + 12, "IHDR", 4 ))
	{
		*ext = "png";
		*w = H9M_Side(((uint)b[16] << 24 ) | ((uint)b[17] << 16 ) | ((uint)b[18] << 8 ) | b[19] );
		*h = H9M_Side(((uint)b[20] << 24 ) | ((uint)b[21] << 16 ) | ((uint)b[22] << 8 ) | b[23] );
		return true;
	}

	if( size >= 26 && b[0] == 'B' && b[1] == 'M' )
	{
		uint dib = b[14] | ( b[15] << 8 ) | ( b[16] << 16 ) | ((uint)b[17] << 24 );

		*ext = "bmp";

		if( dib == 12 ) // OS/2: 16-bit sides
		{
			*w = b[18] | ( b[19] << 8 );
			*h = b[20] | ( b[21] << 8 );
		}
		else
		{
			int sw = (int)( b[18] | ( b[19] << 8 ) | ( b[20] << 16 ) | ((uint)b[21] << 24 ));
			int sh = (int)( b[22] | ( b[23] << 8 ) | ( b[24] << 16 ) | ((uint)b[25] << 24 ));

			// a negative height is a top-down picture
			if( sh < 0 && sh > -( H9M_MAX_SIDE + 1 ))
				sh = -sh;

			*w = sw < 0 ? 0 : H9M_Side( sw );
			*h = sh < 0 ? 0 : H9M_Side( sh );
		}

		return true;
	}

	if( path && size >= 18 && ( b[2] == 1 || b[2] == 2 || b[2] == 3 || b[2] == 9 || b[2] == 10 || b[2] == 11 ))
	{
		size_t n = strcspn( path, "?" );

		if( n >= 4 )
		{
			Q_strncpy( tail, path + n - 4, 5 );

			if( !Q_stricmp( tail, ".tga" ))
			{
				*ext = "tga";
				*w = b[12] | ( b[13] << 8 );
				*h = b[14] | ( b[15] << 8 );
				return true;
			}
		}
	}

	return false;
}

// HTTP_GetToMemory's answer; the frame decides what to do with it
static void H9M_Received( const char *url, qboolean success, const byte *data, size_t size, void *userdata )
{
	const char *ext = NULL;
	char name[32];
	rgbdata_t *pic;
	int w = 0, h = 0;

	if( (int)(intptr_t)userdata != motd.gen || ( motd.state != H9M_FETCH && motd.state != H9M_PAGE ) || motd.picture != H9M_PIC_LOADING )
		return;

	motd.picture = H9M_PIC_FAILED;

	if( !success || !data || !size )
	{
		Con_Printf( "H9 MOTD: the picture could not be fetched from %s\n", motd.image_host );
		return;
	}

	if( size > H9M_MAX_BYTES )
	{
		Con_Printf( "H9 MOTD: the picture is %d bytes, over the limit of %d\n", (int)size, H9M_MAX_BYTES );
		return;
	}

	if( !H9M_PictureSize( data, size, &ext, &w, &h ))
	{
		Con_Printf( "H9 MOTD: the picture from %s is not a PNG, TGA or BMP file\n", motd.image_host );
		return;
	}

	if( w < 1 || h < 1 || w > H9M_MAX_SIDE || h > H9M_MAX_SIDE )
	{
		Con_Printf( "H9 MOTD: the picture is larger than %d x %d pixels\n", H9M_MAX_SIDE, H9M_MAX_SIDE );
		return;
	}

	Q_snprintf( name, sizeof( name ), "#h9motd.%s", ext );
	pic = FS_LoadImage( name, data, size );

	if( !pic )
	{
		Con_Printf( "H9 MOTD: the picture from %s could not be decoded\n", motd.image_host );
		return;
	}

	if( pic->width < 1 || pic->height < 1 || pic->width > H9M_MAX_SIDE || pic->height > H9M_MAX_SIDE )
	{
		Con_Printf( "H9 MOTD: the picture is larger than %d x %d pixels\n", H9M_MAX_SIDE, H9M_MAX_SIDE );
		FS_FreeImage( pic );
		return;
	}

	Q_snprintf( name, sizeof( name ), "#h9motd%d", motd.gen );
	motd.texture = ref.dllFuncs.GL_LoadTextureFromBuffer( name, pic, TF_IMAGE, false );
	motd.picw = pic->width;
	motd.pich = pic->height;
	FS_FreeImage( pic );

	if( !motd.texture )
	{
		Con_Printf( "H9 MOTD: the picture could not be made into a texture\n" );
		motd.picw = motd.pich = 0;
		return;
	}

	motd.picture = H9M_PIC_READY;
}

// the picture is asked for; the frame waits for it
static void H9M_Fetch( void )
{
	motd.picture = H9M_PIC_LOADING;

	// a public address only, checked once resolved and then the one connected to (a host name can
	// point anywhere, 0x7f.1 included), and https only with the certificate checked
	if( !HTTP_GetToMemoryEx( motd.image, H9M_Received, (void *)(intptr_t)motd.gen, HTTP_MEM_PUBLIC_ONLY | HTTP_MEM_VERIFY_TLS ))
		motd.picture = H9M_PIC_FAILED;
}

// the panel comes up: keys and buttons held as it does are let go, as for the console or the menu
static void H9M_Open( void )
{
	// a page on screen needs no picture
	if( motd.view )
	{
		motd.gen++;
		H9M_FreePicture();
	}

	if( cls.key_dest == key_game )
		Key_ClearStates();

	memset( motd.eat, 0, sizeof( motd.eat ));
	motd.confirm = false;
	motd.scroll = 0;
	H9M_Shown( H9M_OPEN );
}

// the panel is up with the page on screen: ESC in the page, a failure, a new window, the window's mode
static void H9M_ViewFrame( void )
{
#if XASH_WIN32
	if( !motd.view )
		return;

	if( motd.view_escape )
	{
		H9M_Stop();
		return;
	}

	if( motd.view_lost )
		H9M_ViewFail( motd.view_why );
	else if( refState.window_mode == WINDOW_MODE_FULLSCREEN )
		H9M_ViewFail( "the game went to exclusive full screen (fullscreen 1)" );
	else if( H9M_GameWindow() != motd.view_window )
		H9M_ViewFail( "the game's window was made again" );

	// gone: the panel stays as the fallback, the text and OPEN PAGE
	if( !motd.view )
	{
		motd.confirm = false;
		return;
	}

	if( motd.newwin[0] )
	{
		Q_strncpy( motd.confirm_url, motd.newwin, sizeof( motd.confirm_url ));
		H9M_HostOf( motd.confirm_url, motd.confirm_host, sizeof( motd.confirm_host ));
		motd.newwin[0] = '\0';
		motd.confirm = true;
	}

	H9M_ViewSync();
#endif
}
#endif // !XASH_EMSCRIPTEN

// the whole message is here: check it, then fetch the picture, load the page or hand it to the page
static void H9M_Begin( const char *info )
{
	char value[H9M_MAX_URL];
	qboolean is_page, every_map, asked;

	if( !cl_h9_motd.value )
	{
		Con_Reportf( "H9 MOTD: cl_h9_motd is 0, the server's text MOTD is shown\n" );
		return;
	}

	if( cls.demoplayback || cls.spectator )
		return;

	if( !H9M_Value( info, "v", value, sizeof( value )) || Q_atoi( value ) < 1 )
		return;

	H9M_Value( info, "type", value, sizeof( value ));

	if( !Q_stricmp( value, "page" ))
		is_page = true;
	else if( !Q_stricmp( value, "image" ))
		is_page = false;
	else return;

	H9M_Value( info, "show", value, sizeof( value ));
	every_map = !Q_stricmp( value, "map" );
	asked = H9M_Value( info, "asked", value, sizeof( value )) && Q_atoi( value ) != 0;

	if( !every_map && motd.shown && !asked )
	{
		// once a connection, and it was shown: this map's text MOTD stays away too
		H9M_Stop();
		motd.heldlen = 0;
		motd.text_done = false;
		motd.textfate = H9M_TEXT_DROP;
		return;
	}

	// a splash already up gives way to this one
	H9M_Stop();
	motd.is_page = is_page;
	motd.image[0] = motd.image_host[0] = '\0';
	motd.page[0] = motd.page_host[0] = '\0';
	motd.title[0] = '\0';

	if( H9M_Value( info, "image", value, sizeof( value )) && value[0] )
	{
		if( H9M_CheckURL( value, true, motd.image_host, sizeof( motd.image_host )))
			Q_strncpy( motd.image, value, sizeof( motd.image ));
		else Con_Printf( "H9 MOTD: the server's picture address was refused: it must be https://<host name>/<path>\n" );
	}

	if( H9M_Value( info, "page", value, sizeof( value )) && value[0] )
	{
		if( H9M_CheckURL( value, false, motd.page_host, sizeof( motd.page_host )))
			Q_strncpy( motd.page, value, sizeof( motd.page ));
		else Con_Printf( "H9 MOTD: the server's page address was refused: it must be https://<host name>\n" );
	}

	if( H9M_Value( info, "title", value, sizeof( value )))
		H9M_Append( motd.title, sizeof( motd.title ), value, Q_strlen( value ), false );

	if( is_page ? !motd.page[0] : !motd.image[0] )
		return; // TS's text, as it comes

	motd.text[0] = '\0';
	motd.text_done = false;
	motd.heldlen = 0;
	motd.textfate = H9M_TEXT_HOLD;
	motd.started = host.realtime;

#if XASH_EMSCRIPTEN
	motd.state = H9M_WEB_ASK;
#else
	if( is_page )
	{
		// the page itself, and its picture alongside for the fallback
		motd.state = H9M_PAGE;

		if( motd.image[0] )
			H9M_Fetch();
	}
	else
	{
		motd.state = H9M_FETCH;
		H9M_Fetch();
	}
#endif
}

// one part of H9Motd: a byte, 1 on the last part, then a string
static void H9M_InfoPart( const byte *buf, int size )
{
	qboolean last;
	size_t n;

	if( size < 1 )
		return;

	last = buf[0] != 0;
	n = Q_strnlen((const char *)buf + 1, size - 1 );

	if( motd.infolen + n < sizeof( motd.info ))
	{
		memcpy( motd.info + motd.infolen, buf + 1, n );
		motd.infolen += n;
		motd.info[motd.infolen] = '\0';
	}
	else motd.infobad = true;

	if( !last )
		return;

	if( motd.infobad )
		Con_Printf( "H9 MOTD: the server's splash message is too long; the text MOTD is shown\n" );
	else H9M_Begin( motd.info );

	motd.infolen = 0;
	motd.info[0] = '\0';
	motd.infobad = false;
}

qboolean CL_Motd_UserMessage( const char *name, const byte *buf, int size )
{
	if( !Q_strcmp( name, "H9Motd" ))
	{
		H9M_InfoPart( buf, size );
		return true;
	}

	if( !Q_strcmp( name, "MOTD" ))
		return H9M_TextPart( buf, size );

	// the game's own handler reads it too
	if( !Q_strcmp( name, "ServerName" ))
		H9UI_NoteServerName( buf, size );

	return false;
}

#if XASH_EMSCRIPTEN
// the page's answer: 1, the splash is on screen; 0, it cannot be shown
static void H9M_Result_f( void )
{
	if( motd.state != H9M_WEB_WAIT )
		return;

	if( Q_atoi( Cmd_Argv( 1 )))
		H9M_Shown( H9M_WEB_OPEN );
	else H9M_Fail( "the browser could not show the splash" );
}
#endif

void CL_Motd_Frame( void )
{
	for( int i = 0; i < h9ui_numpanels; i++ )
		h9ui_panels[i]->Frame();

	if( motd.state == H9M_IDLE || motd.state == H9M_WEB_OPEN )
		return;

#if !XASH_EMSCRIPTEN
	if( motd.state == H9M_OPEN )
	{
		H9M_ViewFrame();
		return;
	}
#endif

	// a splash comes up in the game, never over the loading screen
	if( cls.state != ca_active || cls.signon != SIGNONS )
	{
		H9M_ViewSync();
		return;
	}

	switch( motd.state )
	{
#if XASH_EMSCRIPTEN
	case H9M_WEB_ASK:
		motd.started = host.realtime; // the page's own time to load it starts now
		if( H9M_PageShow( motd.is_page, motd.image, motd.page, motd.title ))
			motd.state = H9M_WEB_WAIT;
		else H9M_Fail( "this page cannot show a splash" );
		break;
	case H9M_WEB_WAIT:
		if( host.realtime - motd.started > H9M_WAIT )
			H9M_Fail( "the browser did not show the splash in time" );
		break;
#else
	case H9M_FETCH:
		if( motd.picture == H9M_PIC_READY )
		{
			H9M_Open();
		}
		else if( motd.picture == H9M_PIC_FAILED || host.realtime - motd.started > H9M_WAIT )
		{
			if( motd.picture != H9M_PIC_FAILED )
				Con_Printf( "H9 MOTD: the picture took longer than %d seconds\n", (int)H9M_WAIT );

			H9M_Fail( "the picture could not be shown" );
		}
		break;
	case H9M_PAGE:
		if( !motd.view_tried )
			H9M_ViewOpen();

		if( motd.view && motd.view_lost )
			H9M_ViewFail( motd.view_why );

		if( motd.view && motd.view_ready )
		{
			H9M_Open(); // the page itself
			break;
		}

		if( motd.view && host.realtime - motd.started <= H9M_WAIT )
		{
			H9M_ViewSync();
			break; // still loading
		}

		if( motd.view )
			H9M_ViewFail( "it did not load within 10 seconds" );

		// the fallback: the page's picture, else TS's text
		if( motd.picture == H9M_PIC_READY )
		{
			H9M_Open();
		}
		else if( motd.picture != H9M_PIC_LOADING || host.realtime - motd.started > H9M_WAIT )
		{
			motd.gen++;
			H9M_FreePicture();
			motd.state = H9M_TEXT;
		}
		break;
	case H9M_TEXT:
		if( motd.text_done || host.realtime - motd.started > H9M_TEXT_WAIT )
			H9M_Open();
		break;
#endif
	default:
		break;
	}
}

/*
==============================================================================

	THE PANELS: who has the input, and the drawing kit every H9 panel uses

==============================================================================
*/

qboolean CL_Motd_Active( void )
{
	return H9M_Up( ) || H9UI_PanelUp( );
}

int CL_Motd_MouseFrame( qboolean mouse_active )
{
	if( CL_Motd_Active( ))
	{
		if( !mouse_active )
			return 0;

		motd.took_mouse = true;
		return 1;
	}

	if( !motd.took_mouse )
		return 0;

	// given back once; out of the game (console, menu) the key_dest change gives it back
	motd.took_mouse = false;
	return ( !mouse_active && cls.key_dest == key_game ) ? 2 : 0;
}

qboolean CL_Motd_KeepsMouse( void )
{
	if( !CL_Motd_Active( ))
		return false;

	// whoever wanted the mouse on gets it when the panel closes
	motd.took_mouse = true;
	return true;
}

const rgba_t h9ui_white = { 255, 250, 255, 255 };
const rgba_t h9ui_light = { 223, 213, 245, 255 };
const rgba_t h9ui_soft  = { 178, 146, 226, 255 };

void H9UI_Fill( int x, int y, int w, int h, byte r, byte g, byte b, byte a )
{
	ref.dllFuncs.FillRGBA( kRenderTransTexture, x, y, w, h, r, g, b, a );
}

void H9UI_Border( int x, int y, int w, int h, int t )
{
	H9UI_Fill( x, y, w, t, 138, 66, 196, 255 );
	H9UI_Fill( x, y + h - t, w, t, 138, 66, 196, 255 );
	H9UI_Fill( x, y, t, h, 138, 66, 196, 255 );
	H9UI_Fill( x + w - t, y, t, h, 138, 66, 196, 255 );
}

int H9UI_Width( cl_font_t *font, const char *s, int n )
{
	int w = 0;

	for( int i = 0; i < n && s[i]; i++ )
		w += font->charWidths[(byte)s[i]];

	return w;
}

void H9UI_Text( cl_font_t *font, int x, int y, const char *s, int n, const rgba_t color )
{
	for( int i = 0; i < n && s[i]; i++ )
		x += CL_DrawCharacter( x, y, (byte)s[i], color, font, 0 );
}

// how many characters of s fit in maxw (one at least), broken after a space when words is set
int H9UI_Fit( cl_font_t *font, const char *s, int maxw, qboolean words )
{
	int w = 0, i, space = -1;

	for( i = 0; s[i] && s[i] != '\n'; i++ )
	{
		int cw = font->charWidths[(byte)s[i]];

		if( w + cw > maxw && i > 0 )
			return ( words && space > 0 ) ? space + 1 : i;

		if( s[i] == ' ' )
			space = i;

		w += cw;
	}

	return i;
}

// s wrapped to maxw; draws count lines from line first at x, y, and returns how many lines it makes
int H9UI_Lines( cl_font_t *font, const char *s, int maxw, qboolean words, int first, int count, int x, int y, const rgba_t color )
{
	int line = 0;

	while( *s )
	{
		int n = H9UI_Fit( font, s, maxw, words );

		if( line >= first && line < first + count )
			H9UI_Text( font, x, y + ( line - first ) * font->charHeight, s, n, color );

		line++;
		s += n;

		if( *s == '\n' )
			s++;
	}

	return line;
}

// one line, cut short with ... when it does not fit
void H9UI_Line( cl_font_t *font, int x, int y, int maxw, const char *s, const rgba_t color )
{
	int len = Q_strlen( s ), n;

	if( H9UI_Width( font, s, len ) <= maxw )
	{
		H9UI_Text( font, x, y, s, len, color );
		return;
	}

	n = H9UI_Fit( font, s, Q_max( 0, maxw - H9UI_Width( font, "...", 3 )), false );
	H9UI_Text( font, x, y, s, n, color );
	H9UI_Text( font, x + H9UI_Width( font, s, n ), y, "...", 3, color );
}

void H9UI_SetRect( h9ui_rect_t *r, int x, int y, int w, int h )
{
	r->x = x;
	r->y = y;
	r->w = w;
	r->h = h;
	r->shown = true;
}

qboolean H9UI_Hit( const h9ui_rect_t *r, int x, int y )
{
	return r->shown && x >= r->x && x < r->x + r->w && y >= r->y && y < r->y + r->h;
}

void H9UI_Button( cl_font_t *font, h9ui_rect_t *r, int x, int y, int w, int h, const char *label, int mx, int my )
{
	qboolean hot;
	int tw = Q_min( w, H9UI_Width( font, label, Q_strlen( label )));

	H9UI_SetRect( r, x, y, w, h );
	hot = H9UI_Hit( r, mx, my );

	H9UI_Fill( x, y, w, h, hot ? 138 : 40, hot ? 66 : 24, hot ? 196 : 58, 255 );
	H9UI_Border( x, y, w, h, 1 );
	H9UI_Line( font, x + ( w - tw ) / 2, y + ( h - font->charHeight ) / 2, w, label, h9ui_white );
}

// the mouse pointer: the game hides the system's while it plays
void H9UI_Cursor( int x, int y, int u )
{
	for( int r = 0; r < 13; r++ )
		H9UI_Fill( x, y + r * u, ( r < 11 ? r + 1 : 11 ) * u, u, 0, 0, 0, 255 );

	for( int r = 2; r < 11; r++ )
		H9UI_Fill( x + u, y + r * u, ( r - 1 ) * u, u, 255, 250, 255, 255 );
}

#if !XASH_EMSCRIPTEN
// the splash's own buttons, by their number
static void H9M_SetRect( int id, int x, int y, int w, int h )
{
	H9UI_SetRect( &motd.btn[id], x, y, w, h );
}

static qboolean H9M_Hit( int id, int x, int y )
{
	return H9UI_Hit( &motd.btn[id], x, y );
}

static void H9M_Button( cl_font_t *font, int id, int x, int y, int w, int h, const char *label, int mx, int my )
{
	H9UI_Button( font, &motd.btn[id], x, y, w, h, label, mx, my );
}

static void H9M_Scroll( int delta )
{
	int most = Q_max( 0, motd.lines - motd.visible );

	motd.scroll = bound( 0, motd.scroll + delta, most );
}

// a page shown by its text: TS's text, or a line saying where the page is
static const char *H9M_Body( void )
{
	if( motd.text[0] )
		return motd.text;

	return "This server's message of the day is a web page. OPEN PAGE opens it in your web browser.";
}

// an address up for a second click
static void H9M_Confirm( const char *url, const char *host )
{
	Q_strncpy( motd.confirm_url, url, sizeof( motd.confirm_url ));
	Q_strncpy( motd.confirm_host, host, sizeof( motd.confirm_host ));
	motd.confirm = true;
}

// the address OPEN IN BROWSER goes to, whole, with the site on its own line, before a second click
static void H9M_DrawConfirm( cl_font_t *font, int W, int H, int pad, int bh, int mx, int my )
{
	static const char ask[] = "Open this address in your web browser?";
	char site[H9M_MAX_HOST + 8];
	int lh = font->charHeight;
	int dw = Q_min( W - pad * 4, H9UI_Width( font, "n", 1 ) * 64 + pad * 2 );
	int tw = dw - pad * 2;
	int asklines = H9UI_Lines( font, ask, tw, true, 0, 0, 0, 0, h9ui_white );
	int urllines = H9UI_Lines( font, motd.confirm_url, tw, false, 0, 0, 0, 0, h9ui_white );
	int dh = pad + lh * ( asklines + 1 ) + pad / 2 + lh * urllines + pad + bh + pad;
	int dx = ( W - dw ) / 2, dy = ( H - dh ) / 2, y, cw, gw;

	H9UI_Fill( 0, 0, W, H, 0, 0, 0, 120 );
	H9UI_Fill( dx, dy, dw, dh, 20, 10, 30, 250 );
	H9UI_Border( dx, dy, dw, dh, 2 );
	H9M_SetRect( H9M_BTN_DIALOG, dx, dy, dw, dh );

	y = dy + pad;
	H9UI_Lines( font, ask, tw, true, 0, asklines, dx + pad, y, h9ui_light );
	y += lh * asklines;

	Q_snprintf( site, sizeof( site ), "Site: %s", motd.confirm_host );
	H9UI_Line( font, dx + pad, y, tw, site, h9ui_white );
	y += lh + pad / 2;

	H9UI_Lines( font, motd.confirm_url, tw, false, 0, urllines, dx + pad, y, h9ui_soft );
	y += lh * urllines + pad;

	cw = H9UI_Width( font, "CANCEL", 6 ) + pad * 2;
	gw = H9UI_Width( font, "OPEN IN BROWSER", 15 ) + pad * 2;
	H9M_Button( font, H9M_BTN_CANCEL, dx + dw - pad - cw, y, cw, bh, "CANCEL", mx, my );
	H9M_Button( font, H9M_BTN_GO, dx + dw - pad - cw - pad - gw, y, gw, bh, "OPEN IN BROWSER", mx, my );
}
#endif // !XASH_EMSCRIPTEN

#if !XASH_EMSCRIPTEN
static void H9M_Draw( void )
{
	char label[H9M_MAX_HOST + 32];
	cl_font_t *font;
	int W, H, lh, pad, bh, margin, head, foot, maxw, maxh, minw;
	int pw, ph, px, py, bodyw, bodyh, mx, my, bmx, bmy;
	qboolean page_up, fallback;

	if( motd.state != H9M_OPEN || cls.state != ca_active )
		return;

	font = Con_GetCurFont();

	if( !font || !font->valid || font->charHeight <= 0 )
		return;

	// the page on screen, or a page shown by its picture or text: the fallback
	page_up = motd.view != NULL;
	fallback = motd.is_page && !page_up;

	W = refState.width;
	H = refState.height;
	lh = font->charHeight;
	pad = Q_max( 6, lh / 2 );
	bh = lh + pad;
	margin = Q_max( 8, Q_min( W, H ) / 30 );
	head = pad + lh * ( fallback ? 3 : 2 ) + pad;
	foot = pad + bh + pad;
	maxw = W - margin * 2;
	maxh = H - margin * 2;
	minw = Q_min( maxw, H9UI_Width( font, "M", 1 ) * 36 + pad * 2 );

	if( maxw <= pad * 4 || maxh <= head + foot + lh * 4 )
		return;

	memset( motd.btn, 0, sizeof( motd.btn ));
	Platform_GetMousePos( &mx, &my );

	// the panel's buttons do not light up under the address box
	bmx = motd.confirm ? -1 : mx;
	bmy = motd.confirm ? -1 : my;

	if( page_up )
	{
		// most of the screen, as a browser window would have it
		pw = Q_max( minw, maxw * 92 / 100 );
		bodyw = pw - pad * 2;
		bodyh = Q_max( lh * 4, maxh * 92 / 100 - head - foot );
	}
	else if( motd.texture )
	{
		// the picture fits the screen; a small one grows up to the screen's own scale
		float s = Q_min(( maxw - pad * 2 ) / (float)motd.picw, ( maxh - head - foot ) / (float)motd.pich );

		s = Q_min( s, Q_max( 1.0f, H / 768.0f ));
		bodyw = Q_max( 1, (int)( motd.picw * s ));
		bodyh = Q_max( 1, (int)( motd.pich * s ));
		pw = Q_max( bodyw + pad * 2, minw );
	}
	else
	{
		pw = Q_max( minw, Q_min( maxw, H9UI_Width( font, "n", 1 ) * 72 + pad * 2 ));
		bodyw = pw - pad * 2;
		motd.lines = H9UI_Lines( font, H9M_Body(), bodyw - pad, true, 0, 0, 0, 0, h9ui_white );
		motd.visible = Q_max( 1, ( maxh - head - foot ) / lh );
		motd.visible = Q_min( motd.visible, Q_max( motd.lines, 4 ));
		bodyh = motd.visible * lh;
		H9M_Scroll( 0 );
	}

	ph = head + bodyh + foot;
	px = ( W - pw ) / 2;
	py = ( H - ph ) / 2;

	H9UI_Fill( 0, 0, W, H, 0, 0, 0, 150 );
	H9UI_Fill( px, py, pw, ph, 14, 8, 20, 240 );
	H9UI_Border( px, py, pw, ph, Q_max( 1, lh / 12 ));

	// the title, then where it comes from: the host is always on screen
	H9UI_Line( font, px + pad, py + pad, pw - pad * 2, motd.title[0] ? motd.title : "Message of the day", h9ui_light );

	if( motd.is_page )
		Q_snprintf( label, sizeof( label ), "Web page at %s", ( page_up && motd.view_host[0] ) ? motd.view_host : motd.page_host );
	else Q_snprintf( label, sizeof( label ), "Picture from %s", motd.image_host );

	H9UI_Line( font, px + pad, py + pad + lh, pw - pad * 2, label, h9ui_soft );

	if( fallback )
		H9UI_Line( font, px + pad, py + pad + lh * 2, pw - pad * 2, "This page could not be shown here.", h9ui_white );

	if( page_up )
	{
		// the page's own window covers this; until it shows, the panel's colour
		H9UI_Fill( px + pad, py + head, bodyw, bodyh, 24, 14, 32, 255 );
		motd.view_x = px + pad;
		motd.view_y = py + head;
		motd.view_w = bodyw;
		motd.view_h = bodyh;
		motd.view_placed = true;
	}
	else if( motd.texture )
	{
		ref.dllFuncs.GL_SetRenderMode( kRenderTransTexture );
		ref.dllFuncs.Color4ub( 255, 255, 255, 255 );
		ref.dllFuncs.R_DrawStretchPic( px + ( pw - bodyw ) / 2, py + head, bodyw, bodyh, 0, 0, 1, 1, motd.texture );
	}
	else
	{
		H9UI_Lines( font, H9M_Body(), bodyw - pad, true, motd.scroll, motd.visible, px + pad, py + head, h9ui_white );

		if( motd.lines > motd.visible )
		{
			int thumb = Q_max( lh / 2, bodyh * motd.visible / motd.lines );
			int at = ( bodyh - thumb ) * motd.scroll / Q_max( 1, motd.lines - motd.visible );

			H9UI_Fill( px + pw - pad - 3, py + head + at, 3, thumb, 138, 66, 196, 255 );
		}
	}

	// CLOSE at the right; OPEN PAGE beside it when there is a page that is not on screen
	{
		int y = py + ph - pad - bh;
		int cw = H9UI_Width( font, "CLOSE (ESC)", 11 ) + pad * 2;
		int x = px + pw - pad - cw;

		H9M_Button( font, H9M_BTN_CLOSE, x, y, cw, bh, "CLOSE (ESC)", bmx, bmy );

		if( motd.page[0] && !page_up )
		{
			int ow;

			Q_snprintf( label, sizeof( label ), "OPEN PAGE (%s)", motd.page_host );
			ow = Q_min( H9UI_Width( font, label, Q_strlen( label )) + pad * 2, x - px - pad * 2 );

			if( ow > pad * 4 )
				H9M_Button( font, H9M_BTN_OPEN, x - pad - ow, y, ow, bh, label, bmx, bmy );
		}
	}

	if( motd.confirm )
		H9M_DrawConfirm( font, W, H, pad, bh, mx, my );

	// the pointer, where the game has it; over the page the system's own shows instead
	if( !host.mouse_visible && !H9UI_PanelUp( ) && !( page_up && !motd.confirm && mx >= motd.view_x && mx < motd.view_x + motd.view_w
		&& my >= motd.view_y && my < motd.view_y + motd.view_h ))
		H9UI_Cursor( mx, my, Q_max( 1, H / 540 ));

	ref.dllFuncs.Color4ub( 255, 255, 255, 255 );
	ref.dllFuncs.GL_SetRenderMode( kRenderNormal );
}
#endif // !XASH_EMSCRIPTEN

void CL_Motd_Draw( void )
{
#if !XASH_EMSCRIPTEN
	H9M_Draw();
#endif

	for( int i = 0; i < h9ui_numpanels; i++ )
		h9ui_panels[i]->Draw();
}

qboolean CL_Motd_KeyEvent( int key, qboolean down )
{
	// another panel above the splash comes first
	for( int i = 0; i < h9ui_numpanels; i++ )
	{
		if( h9ui_panels[i]->KeyEvent( key, down ))
			return true;
	}

	if( key < 0 || key >= (int)ARRAYSIZE( motd.eat ))
		return false;

	if( !down )
	{
		// the release of a key the splash took is the splash's too
		if( !motd.eat[key] )
			return false;

		motd.eat[key] = false;
		return true;
	}

	// the console stays within reach
	if( !H9M_Up( ) || key == '`' || key == '~' )
		return false;

#if !XASH_EMSCRIPTEN
	motd.eat[key] = true;

	switch( key )
	{
	case K_ESCAPE:
		// ESC closes the address box, else the splash; it never opens the browser
		if( motd.confirm )
			motd.confirm = false;
		else H9M_Stop();
		break;
	case K_ENTER:
	case K_KP_ENTER:
	case K_SPACE:
		// the same for a picture or text; with the page on screen these are left alone
		if( motd.confirm )
			motd.confirm = false;
		else if( !motd.view )
			H9M_Stop();
		break;
	case K_UPARROW:
	case K_MWHEELUP:
		H9M_Scroll( -1 );
		break;
	case K_DOWNARROW:
	case K_MWHEELDOWN:
		H9M_Scroll( 1 );
		break;
	case K_PGUP:
		H9M_Scroll( -Q_max( 1, motd.visible - 1 ));
		break;
	case K_PGDN:
		H9M_Scroll( Q_max( 1, motd.visible - 1 ));
		break;
	case K_HOME:
		motd.scroll = 0;
		break;
	case K_END:
		H9M_Scroll( motd.lines );
		break;
	default:
		break;
	}

	return true;
#else
	return false;
#endif
}

qboolean CL_Motd_MouseEvent( int button, qboolean down )
{
	int key = K_MOUSE1 + button;

	for( int i = 0; i < h9ui_numpanels; i++ )
	{
		if( h9ui_panels[i]->MouseEvent( key, down ))
			return true;
	}

	if( key < K_MOUSE1 || key > K_MOUSE5 )
		return false;

	if( !down )
	{
		if( !motd.eat[key] )
			return false;

		motd.eat[key] = false;
		return true;
	}

	if( !H9M_Up( ))
		return false;

#if !XASH_EMSCRIPTEN
	motd.eat[key] = true;

	if( key == K_MOUSE1 )
	{
		int mx, my;

		Platform_GetMousePos( &mx, &my );

		if( motd.confirm )
		{
			// the only way to the browser: a click on OPEN IN BROWSER, with the address on screen
			if( H9M_Hit( H9M_BTN_GO, mx, my ))
			{
				Con_Printf( "H9 MOTD: opening %s in the web browser\n", motd.confirm_url );
				Platform_ShellExecute( motd.confirm_url, NULL );
				motd.confirm = false;
			}
			else if( H9M_Hit( H9M_BTN_CANCEL, mx, my ) || !H9M_Hit( H9M_BTN_DIALOG, mx, my ))
				motd.confirm = false;
		}
		else if( H9M_Hit( H9M_BTN_CLOSE, mx, my ))
			H9M_Stop();
		else if( motd.page[0] && !motd.view && H9M_Hit( H9M_BTN_OPEN, mx, my ))
			H9M_Confirm( motd.page, motd.page_host );
	}

	return true;
#else
	return false;
#endif
}

void CL_Motd_Reset( qboolean connection )
{
	H9M_Stop();
	motd.textfate = H9M_TEXT_PASS;
	motd.heldlen = 0;
	motd.text[0] = '\0';
	motd.text_done = false;
	motd.infolen = 0;
	motd.info[0] = '\0';
	motd.infobad = false;
	memset( motd.eat, 0, sizeof( motd.eat ));

	if( connection )
	{
		motd.shown = false;
		h9ui_server[0] = '\0';
	}

	for( int i = 0; i < h9ui_numpanels; i++ )
		h9ui_panels[i]->Reset( connection );
}

void CL_Motd_Init( void )
{
	Cvar_RegisterVariable( &cl_h9_motd );
#if XASH_WIN32
	Cvar_RegisterVariable( &cl_h9_motd_wine );
#endif
#if XASH_EMSCRIPTEN
	Cmd_AddRestrictedCommand( "h9_motd_result", H9M_Result_f, "H9: the web client's answer to a splash MOTD (1 shown, 0 not shown)" );
#endif
}
