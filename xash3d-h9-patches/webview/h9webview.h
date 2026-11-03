/*
h9webview.h - the C interface of h9webview.dll, H9XASH's embedded web page for a server's
splash MOTD (Microsoft Edge WebView2). The engine loads the DLL itself (cl_motd.c, Windows
only) and calls these by name; cl_motd.c keeps its own copy of the numbers below, so a change
here is a change there, with H9WV_API_VERSION raised.

Every call is made on the thread that owns the parent window (the game's main thread), which
pumps its messages every frame: WebView2 answers through that message loop, and so does the
status callback.
*/

#ifndef H9WEBVIEW_H
#define H9WEBVIEW_H

#define H9WV_API_VERSION 1

// what the view tells the engine; detail is ASCII
enum
{
	H9WV_READY = 1,   // the page has loaded: the view may be shown
	H9WV_FAILED,      // the page cannot be shown; detail says why
	H9WV_ESCAPE,      // ESC was pressed in the page
	H9WV_NEWWINDOW,   // the page asked for a new window; detail is its address (nothing was opened)
	H9WV_NAVIGATED,   // the page is going to detail, an address the rules allow
	H9WV_BLOCKED      // a navigation was refused; detail is its address
};

// H9WV_Open's flags
#define H9WV_NOSANDBOX  1 // Wine: --no-sandbox (Chromium's sandbox does not run under Wine)
#define H9WV_NOGPU      2 // Wine: --disable-gpu as well
#define H9WV_WINEFIX    4 // Wine: set HKCU\Software\Wine\AppDefaults\msedgewebview2.exe\Version
                          // to win8 when it is not set (DirectComposition fails at 8.1 and up)

typedef void ( *h9wv_status_fn )( int status, const char *detail, void *user );

// the DLL exports these; anyone else only declares them
#ifdef H9WV_BUILD
#define H9WV_EXPORT __declspec( dllexport )
#else
#define H9WV_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

// H9WV_API_VERSION
H9WV_EXPORT int H9WV_ApiVersion( void );

// 1 when a WebView2 runtime is there to use, with its version in buf: the Fixed Version runtime
// in <this DLL's folder>\webview2\runtime when that folder has one, else the installed one
H9WV_EXPORT int H9WV_Runtime( char *buf, int size );

// 1 under Wine or Proton (ntdll exports wine_get_version), with Wine's version in buf
H9WV_EXPORT int H9WV_Wine( char *buf, int size );

// Starts a hidden view in parent (an HWND) and sends it to url. NULL, with the reason in why,
// when it cannot start; otherwise status reports what follows. user is handed back as it is.
H9WV_EXPORT void *H9WV_Open( void *parent, const char *url, int flags, h9wv_status_fn status, void *user, char *why, int whysize );

// Where the view sits, in the game's render coordinates: x, y, w, h of a render_w x render_h
// screen, scaled to the parent window's client area. visible 0 hides it.
H9WV_EXPORT void H9WV_Place( void *view, int x, int y, int w, int h, int render_w, int render_h, int visible );

// Takes the view down. No status call follows. The game's window gets the keyboard back when
// the page had it.
H9WV_EXPORT void H9WV_Close( void *view );

#ifdef __cplusplus
}
#endif

#endif // H9WEBVIEW_H
