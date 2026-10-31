// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2017-2026 Alibek Omarov

#include "platform/win32/font.h"
#include "vgui_internal.h"
#include <stdlib.h>

using namespace vgui;

// H9: the game's own fonts. Every .ttf / .otf in <game>\resource\fonts (and valve\resource\fonts)
// is registered for this process only, so a scheme can name it without it being installed;
// and fonts.txt there maps a face the game asks for onto another, for instance
//     font Arial = Square721 BT size 95 weight 700
// so every scheme that names Arial draws in that font. size is a percentage of the
// requested height and weight replaces the requested one; both may be left out.
// Lines that do not start with "font" (the console font line, comments) are ignored.
namespace
{
struct FaceMap
{
	char from[LF_FACESIZE];
	char to[LF_FACESIZE];
	int sizePercent;
	int weight;
};

static FaceMap faceMaps[32];
static int faceMapCount = 0;
static bool gameFontsLoaded = false;

static void trim( char *s )
{
	char *start = s;

	while( *start == ' ' || *start == '\t' )
		start++;

	if( start != s )
		memmove( s, start, strlen( start ) + 1 );

	for( size_t len = strlen( s ); len && ( s[len - 1] == ' ' || s[len - 1] == '\t' || s[len - 1] == '\r' || s[len - 1] == '\n' ); len-- )
		s[len - 1] = 0;
}

// the folder HAVOC 9.exe runs from, and the game it was started with (-game ts)
static void gameFolders( char *base, size_t baseSize, char *game, size_t gameSize )
{
	base[0] = 0;
	::GetModuleFileNameA( nullptr, base, (DWORD)baseSize );
	char *slash = strrchr( base, '\\' );

	if( slash )
		*slash = 0;

	strncpy( game, "valve", gameSize - 1 );
	game[gameSize - 1] = 0;

	const char *cmd = ::GetCommandLineA();
	const char *arg = cmd ? strstr( cmd, " -game " ) : nullptr;

	if( !arg )
		return;

	arg += 7;

	while( *arg == ' ' )
		arg++;

	bool quoted = *arg == '"';

	if( quoted )
		arg++;

	size_t i = 0;

	while( arg[i] && i < gameSize - 1 && ( quoted ? arg[i] != '"' : arg[i] != ' ' ))
	{
		game[i] = arg[i];
		i++;
	}

	game[i] = 0;
}

static void registerFolder( const char *dir )
{
	static const char *const kinds[] = { "*.ttf", "*.otf" };

	for( const char *kind : kinds )
	{
		char pattern[MAX_PATH];
		_snprintf( pattern, sizeof( pattern ) - 1, "%s\\%s", dir, kind );
		pattern[sizeof( pattern ) - 1] = 0;

		WIN32_FIND_DATAA fd;
		HANDLE find = ::FindFirstFileA( pattern, &fd );

		if( find == INVALID_HANDLE_VALUE )
			continue;

		do
		{
			char path[MAX_PATH];
			_snprintf( path, sizeof( path ) - 1, "%s\\%s", dir, fd.cFileName );
			path[sizeof( path ) - 1] = 0;

			if( ::AddFontResourceExA( path, FR_PRIVATE, nullptr ) <= 0 )
				vgui_dprintf( "vgui: could not register font %s\n", path );
		} while( ::FindNextFileA( find, &fd ));

		::FindClose( find );
	}
}

static bool readFaceMaps( const char *dir )
{
	char path[MAX_PATH];
	_snprintf( path, sizeof( path ) - 1, "%s\\fonts.txt", dir );
	path[sizeof( path ) - 1] = 0;

	FILE *f = fopen( path, "r" );

	if( !f )
		return false;

	char line[256];

	while( fgets( line, sizeof( line ), f ) && faceMapCount < (int)( sizeof( faceMaps ) / sizeof( faceMaps[0] )))
	{
		char *comment = strstr( line, "//" );

		if( comment )
			*comment = 0;

		trim( line );

		if( _strnicmp( line, "font ", 5 ))
			continue;

		char *eq = strchr( line, '=' );

		if( !eq )
			continue;

		*eq = 0;
		FaceMap &m = faceMaps[faceMapCount];
		memset( &m, 0, sizeof( m ));
		m.sizePercent = 100;

		strncpy( m.from, line + 5, sizeof( m.from ) - 1 );
		trim( m.from );

		// the face is every word up to "size" or "weight"
		char face[LF_FACESIZE * 2] = { 0 };

		for( char *word = strtok( eq + 1, " \t" ); word; word = strtok( nullptr, " \t" ))
		{
			if( !_stricmp( word, "size" ) || !_stricmp( word, "weight" ))
			{
				char *value = strtok( nullptr, " \t" );

				if( value && !_stricmp( word, "size" ))
					m.sizePercent = atoi( value );
				else if( value )
					m.weight = atoi( value );

				continue;
			}

			if( face[0] )
				strncat( face, " ", sizeof( face ) - strlen( face ) - 1 );

			strncat( face, word, sizeof( face ) - strlen( face ) - 1 );
		}

		strncpy( m.to, face, sizeof( m.to ) - 1 );

		if( m.from[0] && m.to[0] && m.sizePercent > 0 )
			faceMapCount++;
	}

	fclose( f );
	return true;
}

static void loadGameFonts()
{
	if( gameFontsLoaded )
		return;

	gameFontsLoaded = true;

	char base[MAX_PATH], game[64];
	gameFolders( base, sizeof( base ), game, sizeof( game ));

	const char *games[] = { game, "valve" };
	bool mapped = false;

	for( int i = 0; i < 2; i++ )
	{
		if( i == 1 && !_stricmp( game, "valve" ))
			break;

		char dir[MAX_PATH];
		_snprintf( dir, sizeof( dir ) - 1, "%s\\%s\\resource\\fonts", base, games[i] );
		dir[sizeof( dir ) - 1] = 0;

		registerFolder( dir );

		// the game's own mapping wins; valve's is read only when the game has none
		if( !mapped )
			mapped = readFaceMaps( dir );
	}
}

static const FaceMap *findFaceMap( const char *name )
{
	for( int i = 0; i < faceMapCount; i++ )
	{
		if( !_stricmp( faceMaps[i].from, name ))
			return &faceMaps[i];
	}

	return nullptr;
}
}

FontPlat_Win32::FontPlat_Win32() : name( nullptr ), tall( 0 ), wide( 0 ), weight( 0 ),
	rotation( 0.0f ),
	italic( false ), underline( false ), strikeout( false ), symbol( false ),
	dc( nullptr ), font( nullptr ), dib( nullptr ),
	dibPixels( nullptr ),
	height( 0 ), maxCharWidth( 0 )
{
	dibSize[0] = dibSize[1] = 0;
}

FontPlat_Win32::~FontPlat_Win32()
{
	// the DC holds the font and the bitmap selected; drop them first
	if( dc )
		::DeleteDC( dc );

	if( font )
		::DeleteObject( font );

	if( dib )
		::DeleteObject( dib );

	delete[] name;
}

FontPlat_Win32 *FontPlat_Win32::Create( const char *name, int tall, int wide, float rotation, int weight, bool italic, bool underline, bool strikeout, bool symbol )
{
	if( !name )
		return nullptr;

	FontPlat_Win32 *font = new FontPlat_Win32();

	if( !font )
		return nullptr;

	if( !font->init( name, tall, wide, rotation, weight, italic, underline, strikeout, symbol ))
	{
		delete font;
		return nullptr;
	}

	return font;
}

bool FontPlat_Win32::init( const char *newName, int newTall, int newWide, float newRotation, int newWeight, bool newItalic, bool newUnderline, bool newStrikeout, bool newSymbol )
{
	name = vgui_strdup( newName );

	if( !name )
		return false;

	tall = newTall;
	wide = newWide;
	rotation = newRotation;
	weight = newWeight;
	italic = newItalic;
	underline = newUnderline;
	strikeout = newStrikeout;
	symbol = newSymbol;

	dc = ::CreateCompatibleDC( nullptr );

	if( !dc )
		return false;

	// escapement and orientation are in tenths of a degree
	int escapement = (int)( rotation * 10.0f );

	// H9: the face, height and weight fonts.txt gives for this name. The font keeps the name and
	// size it was asked for, which is how freevgui finds it again in its cache.
	loadGameFonts();

	const char *face = name;
	int faceTall = tall, faceWide = wide, faceWeight = weight;
	const FaceMap *map = findFaceMap( name );

	if( map )
	{
		face = map->to;
		faceTall = tall * map->sizePercent / 100;
		faceWide = wide * map->sizePercent / 100;

		if( map->weight > 0 )
			faceWeight = map->weight;
	}

	font = ::CreateFontA( faceTall, faceWide, escapement, escapement, faceWeight, italic, underline, strikeout,
		symbol ? SYMBOL_CHARSET : DEFAULT_CHARSET,
		OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, PROOF_QUALITY,
		DEFAULT_PITCH | FF_DONTCARE, face );

	if( !font )
	{
		vgui_dprintf( "vgui: CreateFont failed for \"%s\"\n", name );
		return false;
	}

	::SetMapMode( dc, MM_TEXT );
	::SelectObject( dc, font );
	::SetTextAlign( dc, TA_LEFT | TA_TOP | TA_UPDATECP );

	::TEXTMETRICW tm = { 0 };

	if( !::GetTextMetricsW( dc, &tm ))
	{
		vgui_dprintf( "vgui: GetTextMetrics failed for \"%s\"\n", name );
		return false;
	}

	height = tm.tmHeight;
	maxCharWidth = tm.tmMaxCharWidth;

	// scratch surface for the ExtTextOut fallback below. Top-down (negative height) so its rows match the RGBA buffer we copy into.
	dibSize[0] = maxCharWidth;
	dibSize[1] = height;

	::BITMAPINFOHEADER header = { 0 };
	header.biSize = sizeof( header );
	header.biWidth = dibSize[0];
	header.biHeight = -dibSize[1];
	header.biPlanes = 1;
	header.biBitCount = 32;
	header.biCompression = BI_RGB;

	dib = ::CreateDIBSection( dc, (BITMAPINFO *)&header, DIB_RGB_COLORS, (void **)&dibPixels, nullptr, 0 );

	if( !dib || !dibPixels )
	{
		vgui_dprintf( "vgui: CreateDIBSection failed for \"%s\"\n", name );
		return false;
	}

	::SelectObject( dc, dib );

	return true;
}

bool FontPlat_Win32::equals( const char *newName, int newTall, int newWide, float newRotation, int newWeight, bool newItalic, bool newUnderline, bool newStrikeout, bool newSymbol )
{
	return newName && !strcmp( name, newName )
		&& tall == newTall && wide == newWide && rotation == newRotation && weight == newWeight
		&& italic == newItalic && underline == newUnderline && strikeout == newStrikeout && symbol == newSymbol;
}

void FontPlat_Win32::blendGlyphPixel( unsigned char *rgba, int rgbaWide, int rgbaTall, int x, int y, unsigned char coverage )
{
	if( x < 0 || y < 0 || x >= rgbaWide || y >= rgbaTall )
		return;

	unsigned char *dst = &rgba[( y * rgbaWide + x ) * 4];

	// white glyph, coverage in alpha -- the surface modulates by the text colour
	dst[0] = dst[1] = dst[2] = 255;
	dst[3] = coverage;
}

void FontPlat_Win32::getCharRGBA( int ch, int rgbaX, int rgbaY, int rgbaWide, int rgbaTall, unsigned char *rgba )
{
	if( !rgba || !dc || !dibPixels )
		return;

	int a, b, c;

	getCharABCwide( ch, a, b, c );

	int glyphWide = b, glyphTall = height;

	if( underline ) // the underline runs the full advance, bearings included
		glyphWide += a + c;

	if( glyphWide > dibSize[0] )
		glyphWide = dibSize[0];

	if( glyphTall > dibSize[1] )
		glyphTall = dibSize[1];

	memset( dibPixels, 0, dibSize[0] * dibSize[1] * 4 );

	::SelectObject( dc, font );
	::SetBkColor( dc, RGB( 0, 0, 0 ));
	::SetTextColor( dc, RGB( 255, 255, 255 ));
	::SetBkMode( dc, OPAQUE );

	// shift out the left bearing so the black box lands at the cell origin
	::MoveToEx( dc, underline ? 0 : -a, 0, nullptr );

	wchar_t wch = (wchar_t)ch;
	::ExtTextOutW( dc, 0, 0, 0, nullptr, &wch, 1, nullptr );
	::SetBkMode( dc, TRANSPARENT );

	for( int j = 0; j < glyphTall; j++ )
	{
		for( int i = 0; i < glyphWide; i++ )
		{
			const unsigned char *src = &dibPixels[( j * dibSize[0] + i ) * 4];
			unsigned int coverage = ( src[2] * 77 + src[1] * 151 + src[0] * 28 ) >> 8;

			blendGlyphPixel( rgba, rgbaWide, rgbaTall, rgbaX + i, rgbaY + j, (unsigned char)coverage );
		}
	}
}

void FontPlat_Win32::getCharABCwide( int ch, int &a, int &b, int &c )
{
	a = b = c = 0;

	if( !dc )
		return;

	::SelectObject( dc, font );

	ABC abc;

	if( ::GetCharABCWidthsW( dc, ch, ch, &abc ))
	{
		a = abc.abcA;
		b = abc.abcB;
		c = abc.abcC;
		return;
	}

	// raster faces have no ABC widths at all
	INT width = 0;

	if( ::GetCharWidth32W( dc, ch, ch, &width ))
	{
		b = width;
		return;
	}

	b = maxCharWidth;
}

int FontPlat_Win32::getTall()
{
	return height;
}

int FontPlat_Win32::getWide()
{
	return maxCharWidth;
}

void FontPlat_Win32::drawSetTextFont( SurfacePlat * )
{
	// stub
}

BaseFontPlat *vgui::FontPlat_CreateSystem( const char *name, int tall, int wide, float rotation, int weight, bool italic, bool underline, bool strikeout, bool symbol )
{
	return FontPlat_Win32::Create( name, tall, wide, rotation, weight, italic, underline, strikeout, symbol );
}
