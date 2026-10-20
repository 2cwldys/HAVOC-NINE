// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2024-2026 Alibek Omarov

#include "scheme.h"
#include "vgui_internal.h"
#include "font.h"

using namespace vgui;

Scheme::Scheme()
{
	setColor( SC_BLACK,      0,   0,   0,   0 );
	setColor( SC_WHITE,      255, 255, 255, 0 );
	// H9: the purple VGUI1 scheme, the same six colours as H9's patched GoldSrc vgui.dll
	// (stock: 102,102,153 / 153,153,204 / 204,204,255 / 102,102,102 / 153,153,153 / 204,204,204).
	setColor( SC_PRIMARY1,   223, 213, 245, 0 );
	setColor( SC_PRIMARY2,   138,  66, 196, 0 );
	setColor( SC_PRIMARY3,   178, 146, 226, 0 );
	setColor( SC_SECONDARY1, 122,  86, 180, 0 );
	setColor( SC_SECONDARY2, 255, 250, 255, 0 );
	setColor( SC_SECONDARY3, 200, 186, 230, 0 );
	setColor( SC_USER,       0,   0,   0, 0 );
	setFont( SF_PRIMARY1,
				new Font( "Arial",    0, 0, 20, 0, 0, 400, false, false, false, false ));
	setFont( SF_PRIMARY2,
				new Font( "FixedSys", 0, 0, 18, 0, 0, 400, false, false, false, false ));
	setFont( SF_PRIMARY3,
				new Font( "Arial",    0, 0, 12, 0, 0, 400, false, false, false, false ));
	setFont( SF_SECONDARY,
				new Font( "Marlett",  0, 0, 16, 0, 0, 0,   false, false, false, false ));

	for( int i = Cursor::DC_USER; i < Cursor::DC_LAST; i++ )
		setCursor( static_cast<SchemeCursor>( i ),
					  new Cursor( static_cast<Cursor::DefaultCursor>( i )));
}

void Scheme::setColor(SchemeColor sc, int r, int g, int b, int a)
{
	colors[sc][0] = r;
	colors[sc][1] = g;
	colors[sc][2] = b;
	colors[sc][3] = a;
}

void Scheme::getColor(SchemeColor sc, int &r, int &g, int &b, int &a)
{
	r = colors[sc][0];
	g = colors[sc][1];
	b = colors[sc][2];
	a = colors[sc][3];
}

void Scheme::setFont(SchemeFont sf, Font *font)
{
	if( font )
		fonts[sf] = font;
}

Font *Scheme::getFont(SchemeFont sf)
{
	return fonts[sf];
}

void Scheme::setCursor(SchemeCursor scu, Cursor *cursor)
{
	if( cursor )
		cursors[scu] = cursor;
}

Cursor *Scheme::getCursor(SchemeCursor scu)
{
	return cursors[scu];
}
