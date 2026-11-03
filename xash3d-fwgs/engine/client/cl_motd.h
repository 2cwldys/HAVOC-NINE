/*
cl_motd.h - H9: the splash MOTD, a server's picture or web page shown at join (cl_motd.c)

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
*/

#ifndef CL_MOTD_H
#define CL_MOTD_H

#include "xash3d_types.h"

void CL_Motd_Init( void );
void CL_Motd_Reset( qboolean connection );
void CL_Motd_Frame( void );
void CL_Motd_Draw( void );

// called for every user message once its bytes are read; true when the engine took it
qboolean CL_Motd_UserMessage( const char *name, const byte *buf, int size );

// the native splash is up and has the keyboard and mouse (key_game, connected)
qboolean CL_Motd_Active( void );
qboolean CL_Motd_KeyEvent( int key, qboolean down );
qboolean CL_Motd_MouseEvent( int button, qboolean down );

// once a frame from IN_Commands: 1 = turn the game's mouse off, 2 = give it back, 0 = nothing
int CL_Motd_MouseFrame( qboolean mouse_active );

// IN_ActivateMouse asks first: true while the splash keeps the mouse off (it gives it back when it closes)
qboolean CL_Motd_KeepsMouse( void );


// ---- H9's engine-drawn panels -------------------------------------------------------------
// The drawing kit the splash uses, for any other panel (needs client.h before this header), and a
// registry of those panels: each registered one gets the keys, the mouse and a frame before the
// splash, is drawn above it, and is reset with it (a new map, a disconnect).

typedef struct
{
	int x, y, w, h;
	qboolean shown;
} h9ui_rect_t;

typedef struct h9ui_panel_s
{
	qboolean ( *Active )( void );                       // up in the game: it has the keys and the mouse
	qboolean ( *KeyEvent )( int key, qboolean down );   // true when it took the key (and so its release)
	qboolean ( *MouseEvent )( int key, qboolean down ); // the same for K_MOUSE1..K_MOUSE5
	void ( *Frame )( void );
	void ( *Draw )( void );                             // in 2D, after the HUD, VGUI and the splash
	void ( *Reset )( qboolean connection );
} h9ui_panel_t;

void H9UI_AddPanel( const h9ui_panel_t *panel );

// the name the server the player is on gave itself (the game's ServerName message, its
// hostname), printable ASCII only; empty before it came and after a disconnect
const char *H9UI_ServerName( void );

extern const rgba_t h9ui_white, h9ui_light, h9ui_soft;
void H9UI_Fill( int x, int y, int w, int h, byte r, byte g, byte b, byte a );
void H9UI_Border( int x, int y, int w, int h, int t );
int H9UI_Width( cl_font_t *font, const char *s, int n );
void H9UI_Text( cl_font_t *font, int x, int y, const char *s, int n, const rgba_t color );
int H9UI_Fit( cl_font_t *font, const char *s, int maxw, qboolean words );
int H9UI_Lines( cl_font_t *font, const char *s, int maxw, qboolean words, int first, int count, int x, int y, const rgba_t color );
void H9UI_Line( cl_font_t *font, int x, int y, int maxw, const char *s, const rgba_t color );
void H9UI_SetRect( h9ui_rect_t *r, int x, int y, int w, int h );
qboolean H9UI_Hit( const h9ui_rect_t *r, int x, int y );
void H9UI_Button( cl_font_t *font, h9ui_rect_t *r, int x, int y, int w, int h, const char *label, int mx, int my );
void H9UI_Cursor( int x, int y, int u );

#endif // CL_MOTD_H
