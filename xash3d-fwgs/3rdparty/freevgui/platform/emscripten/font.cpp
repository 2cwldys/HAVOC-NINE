// SPDX-License-Identifier: BSD-3-Clause
// msr-web: system fonts for the browser. The glyphs are rasterised once per font through a 2D canvas,
// which gives the page's own fonts (and the user's installed ones) by name, like GDI does on Windows.

#include <emscripten.h>
#include <stdio.h>
#include <stdint.h>
#include "platform/common/font.h"
#include "vgui_internal.h"

using namespace vgui;

static constexpr int FONT_GLYPHS = 256;

// Fills widths[256] with the advance of every Latin-1 glyph and, when bitmap is non-null, one byte of
// coverage per pixel laid out as bitmap[cellWide * ( ch + y * 256 ) + x]. Returns the widest advance.
// EM_JS symbols of a side module are not resolved by this loader, so the function is installed with
// emscripten_run_script instead; the script runs in the main module's scope, where the heap views live.
static const char *FONT_RASTER_JS = R"JS(Module.vguiFontRaster = function( name, tall, weight, italic, widths, bitmap, cellWide ) {
	var family = UTF8ToString( name ).replace( /[^A-Za-z0-9 _-]/g, "" );
	var canvas = Module.vguiFontCanvas || ( Module.vguiFontCanvas = document.createElement( "canvas" ));
	var ctx = canvas.getContext( "2d", { willReadFrequently: true });
	var fontOf = function( px ) {
		return ( italic ? "italic " : "" ) + ( weight >= 100 ? Math.min( weight, 900 ) : 400 ) + " " + px + "px " + family + ", " + family + " Text, Georgia, serif"; // unquoted: a lone quote would not survive the C preprocessor
	};

	// VGUI's height is the whole cell (ascent plus descent), a canvas font size is the em box
	ctx.font = fontOf( 100 );
	var m = ctx.measureText( "Mg" );
	var asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 80, desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 20;
	var px = tall * 100 / ( asc + desc );
	var baseline = Math.round( tall * asc / ( asc + desc ));
	var font = fontOf( px );

	ctx.font = font;
	var widest = 1, w = [];
	for( var ch = 0; ch < 256; ch++ )
	{
		w[ch] = Math.max( 1, Math.ceil( ctx.measureText( String.fromCharCode( ch < 32 ? 32 : ch )).width ));
		HEAP32[( widths >> 2 ) + ch] = w[ch];
		if( w[ch] > widest ) widest = w[ch];
	}

	if( !bitmap )
		return widest;

	canvas.width = cellWide;
	canvas.height = tall;
	for( var ch = 33; ch < 256; ch++ )
	{
		ctx.clearRect( 0, 0, cellWide, tall );
		ctx.font = font; // resizing the canvas resets the context
		ctx.fillStyle = "#fff";
		ctx.textBaseline = "alphabetic";
		ctx.fillText( String.fromCharCode( ch ), 0, baseline );
		var data = ctx.getImageData( 0, 0, cellWide, tall ).data;
		for( var y = 0; y < tall; y++ )
			for( var x = 0; x < cellWide; x++ )
				HEAPU8[bitmap + cellWide * ( ch + y * 256 ) + x] = data[( y * cellWide + x ) * 4 + 3];
	}
	return widest;
};)JS";

static int FontCanvas_Raster( const char *name, int tall, int weight, int italic, int *widths, unsigned char *bitmap, int cellWide )
{
	static bool installed;
	char call[256];

	if( !installed )
	{
		emscripten_run_script( FONT_RASTER_JS );
		installed = true;
	}

	snprintf( call, sizeof( call ), "Module.vguiFontRaster(%u,%d,%d,%d,%u,%u,%d)", (unsigned)(uintptr_t)name, tall, weight, italic,
		(unsigned)(uintptr_t)widths, (unsigned)(uintptr_t)bitmap, cellWide );
	return emscripten_run_script_int( call );
}

class FontPlat_Canvas : public BaseFontPlat
{
public:
	FontPlat_Canvas( const char *newName, int newTall, int newWeight, bool newItalic ) :
		name( vgui_strdup( newName )), tall( newTall > 0 ? newTall : 1 ), weight( newWeight ), italic( newItalic )
	{
		cellWide = FontCanvas_Raster( name, tall, weight, italic, widths, nullptr, 0 );
		bitmap = new unsigned char[cellWide * FONT_GLYPHS * tall];
		memset( bitmap, 0, cellWide * FONT_GLYPHS * tall );
		FontCanvas_Raster( name, tall, weight, italic, widths, bitmap, cellWide );
	}

	virtual ~FontPlat_Canvas() override
	{
		delete[] bitmap;
		delete[] name;
	}

	virtual bool equals( const char *newName, int newTall, int, float, int newWeight, bool newItalic, bool, bool, bool ) override
	{
		return tall == newTall && weight == newWeight && italic == newItalic && !strcmp( name, newName );
	}

	virtual void getCharRGBA( int ch, int rgbaX, int rgbaY, int rgbaWide, int rgbaTall, unsigned char *rgba ) override
	{
		ch = bound( 0, ch, FONT_GLYPHS - 1 );

		for( int y = 0; y < tall; y++ )
		{
			const unsigned char *src = &bitmap[cellWide * ( ch + y * FONT_GLYPHS )];

			for( int x = 0; x < widths[ch]; x++ )
			{
				int outX = rgbaX + x, outY = rgbaY + y;

				if( outX < rgbaWide && outY < rgbaTall )
				{
					unsigned char *out = &rgba[( outY * rgbaWide + outX ) * 4];

					out[0] = out[1] = out[2] = 255;
					out[3] = src[x];
				}
			}
		}
	}

	virtual void getCharABCwide( int ch, int &a, int &b, int &c ) override
	{
		a = c = 0;
		b = widths[bound( 0, ch, FONT_GLYPHS - 1 )];
	}

	virtual int getTall() override { return tall; }
	virtual int getWide() override { return cellWide; }
	virtual void drawSetTextFont( SurfacePlat * ) override {}

private:
	char *name;
	unsigned char *bitmap;
	int tall, weight, cellWide;
	bool italic;
	int widths[FONT_GLYPHS];
};

BaseFontPlat *vgui::FontPlat_CreateSystem( const char *name, int tall, int, float, int weight, bool italic, bool, bool, bool )
{
	return new FontPlat_Canvas( name, tall, weight, italic );
}
