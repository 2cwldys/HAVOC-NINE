/*
Copyright (C) 1997-2001 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

*/


#include "Framework.h"
#include "Action.h"
#include "Bitmap.h"
#include "PicButton.h"
#include "YesNoMessageBox.h"
#include "keydefs.h"
#include "MenuStrings.h"
#include "PlayerIntroduceDialog.h"
#include "gameinfo.h"
#include "AnimatedBanner.h"
#include "MovieBanner.h"

#define ART_MINIMIZE_N	"gfx/shell/min_n"
#define ART_MINIMIZE_F	"gfx/shell/min_f"
#define ART_MINIMIZE_D	"gfx/shell/min_d"
#define ART_CLOSEBTN_N	"gfx/shell/cls_n"
#define ART_CLOSEBTN_F	"gfx/shell/cls_f"
#define ART_CLOSEBTN_D	"gfx/shell/cls_d"

#if !defined( __EMSCRIPTEN__ )
/*
=================
H9: Link your Account / Unlink your Account

The engine keeps this game's id and its link to a havoc9.org account (cl_h9link.c,
engine-h9-link.patch): _h9lnk is "1" while the game is linked and "0" while it is not, and an
engine without it has no _h9lnk, so the button stays hidden. Beside the text is the scoreboard's
chain: gfx/vgui/h9_link.tga, green and whole, when linked; gfx/vgui/h9_unlink.tga, red and broken,
when not. Not linked, the button opens the link dialog, which runs h9_link; linked, it asks, then
runs h9_unlink. It stands in the column directly below Change Game, above Quit
(CMenuMain::H9LinkPlace). The dialogs name the site the engine talks to, _h9link_site: havoc9.org,
or the local test site cl_h9_site names. Everything shown comes from the engine's cvars: no network
call.
=================
*/
class CMenuH9LinkDialog : public CMenuYesNoMessageBox
{
public:
	CMenuH9LinkDialog() : CMenuYesNoMessageBox( false ) { bAutoHide = false; }

	void Open()
	{
		EngFuncs::ClientCmd( false, "h9_link\n" );
		Show();
	}

	void Draw() override
	{
		Refresh();
		CMenuYesNoMessageBox::Draw();
	}

private:
	void _Init() override
	{
		SetPositiveButton( L( "OPEN PAGE" ), PC_OK, 40 );
		SetNegativeButton( L( "GameUI_Cancel" ), PC_CANCEL );
		onPositive.pExtra = onNegative.pExtra = this;
		SET_EVENT_MULTI( onPositive, { ((CMenuH9LinkDialog *)pExtra)->Positive(); });
		SET_EVENT_MULTI( onNegative, { ((CMenuH9LinkDialog *)pExtra)->Negative(); });
		CMenuYesNoMessageBox::_Init();
	}

	// _h9link_flow: 0 nothing yet, 1 asking for a code, 2 waiting for its approval, 3 linked, 4 failed
	void Refresh()
	{
		const int flow = (int)EngFuncs::GetCvarFloat( "_h9link_flow" );
		const char *text = EngFuncs::GetCvarString( "_h9link_text" );
		const char *site = EngFuncs::GetCvarString( "_h9link_site" );
		char title[96];

		snprintf( title, sizeof( title ), "%s %s", L( "LINK THIS GAME TO YOUR ACCOUNT ON" ), site );
		switch( flow )
		{
		case 2:
			snprintf( m_message, sizeof( m_message ), "%s\n\n%s   %s\n\n%s %s/link %s\n%s\n\n%s",
				title, L( "Your code:" ), EngFuncs::GetCvarString( "_h9link_code" ),
				L( "OPEN PAGE opens" ), site, L( "in your web browser. Sign in there," ),
				L( "check that it shows this code, and press LINK." ), text );
			yes.szName = L( "OPEN PAGE" );
			no.szName = L( "GameUI_Cancel" );
			no.Show();
			break;
		case 3:
			snprintf( m_message, sizeof( m_message ), "%s\n\n%s", L( "LINKED" ), text );
			yes.szName = L( "GameUI_OK" );
			no.Hide();
			break;
		case 4:
			snprintf( m_message, sizeof( m_message ), "%s\n\n%s", title, text );
			yes.szName = L( "TRY AGAIN" );
			no.szName = L( "Close" );
			no.Show();
			break;
		default:
			if( flow == 1 && text[0] )
				snprintf( m_message, sizeof( m_message ), "%s\n\n%s", title, text );
			else snprintf( m_message, sizeof( m_message ), "%s\n\n%s %s %s", title, L( "Asking" ), site, L( "for a code..." ));
			yes.szName = L( "OPEN PAGE" );
			no.szName = L( "GameUI_Cancel" );
			no.Show();
			break;
		}
		SetMessage( m_message );
	}

	void Positive()
	{
		switch( (int)EngFuncs::GetCvarFloat( "_h9link_flow" ))
		{
		case 1:
			break; // still asking
		case 2:
			EngFuncs::ClientCmd( false, "h9_link open\n" );
			break;
		case 4:
			EngFuncs::ClientCmd( false, "h9_link\n" );
			break;
		default:
			Hide();
			break;
		}
	}

	void Negative()
	{
		const int flow = (int)EngFuncs::GetCvarFloat( "_h9link_flow" );

		if( flow == 1 || flow == 2 )
			EngFuncs::ClientCmd( false, "h9_link cancel\n" );
		Hide();
	}

	char m_message[512];
};

class CMenuH9LinkButton : public CMenuPicButton
{
public:
	void Think() override
	{
		const char *lnk = EngFuncs::GetCvarString( "_h9lnk" );
		const int state = !lnk || !lnk[0] ? -1 : ( lnk[0] == '1' ? 1 : 0 );

		if( state != m_state )
		{
			m_state = state;
			if( state < 0 )
				Hide();
			else
			{
				if( state )
					SetNameAndStatus( L( "Unlink your Account" ), L( "This game is linked to your havoc9.org account" ));
				else SetNameAndStatus( L( "Link your Account" ), L( "Link this game to your havoc9.org account" ));
				Show();
			}
		}

		CMenuPicButton::Think();
	}

	void Draw() override
	{
		CMenuPicButton::Draw();

		if( !m_looked )
		{
			m_looked = true;
			m_picLinked = EngFuncs::PIC_Load( "gfx/vgui/h9_link.tga" );
			m_picUnlinked = EngFuncs::PIC_Load( "gfx/vgui/h9_unlink.tga" );
		}

		const HIMAGE pic = m_state == 1 ? m_picLinked : m_picUnlinked;

		if( !pic || !szName )
			return;

		// the chain, as tall as the text, right after it
		const int side = m_scChSize;
		const int x = m_scPos.x + g_FontMgr->GetTextWideScaled( font, szName, m_scChSize ) + side / 3;
		const int y = m_scPos.y + ( m_scSize.h - side ) / 2;

		EngFuncs::PIC_Set( pic, 255, 255, 255, FBitSet( iFlags, QMF_GRAYED ) ? 128 : 255 );
		EngFuncs::PIC_DrawTrans( x, y, side, side );
	}

private:
	int m_state = -2; // -1 hidden (an engine without the link), 0 not linked, 1 linked
	bool m_looked = false;
	HIMAGE m_picLinked = 0;
	HIMAGE m_picUnlinked = 0;
};
#endif // !__EMSCRIPTEN__

class CMenuMain: public CMenuFramework
{
public:
	CMenuMain() : CMenuFramework( "CMenuMain" ) { }

	bool KeyDown( int key ) override;

	void QuitDialogCb();

private:
	void _Init() override;
	void _VidInit( ) override;
	void Think() override;

	void VidInit(bool connected);

	void DisconnectCb();
	void DisconnectDialogCb();
	void HazardCourseDialogCb();
	void HazardCourseCb();
#if !defined( __EMSCRIPTEN__ )
	void H9LinkCb();
	void H9LinkPlace();
#endif

	CMenuAnimatedBanner animatedBanner;
	CMenuMovieBanner movieBanner;

	CMenuPicButton	console;
	CMenuPicButton	resumeGame;
	CMenuPicButton	disconnect;
	CMenuPicButton	newGame;
	CMenuPicButton	hazardCourse;
	CMenuPicButton	configuration;
	CMenuPicButton	saveRestore;
	CMenuPicButton	multiPlayer;
	CMenuPicButton	customGame;
	CMenuPicButton	previews;
	CMenuPicButton	quit;

	// buttons on top right. Maybe should be drawn if fullscreen == 1?
	CMenuBitmap	minimizeBtn;
	CMenuBitmap	quitButton;

	// quit dialog
	CMenuYesNoMessageBox dialog;

#if !defined( __EMSCRIPTEN__ )
	// H9: Link your Account / Unlink your Account, and its dialog
	CMenuH9LinkButton h9link;
	CMenuH9LinkDialog h9linkDialog;
#endif

	bool bTrainMap;
	bool bCustomGame;
};

void CMenuMain::QuitDialogCb()
{
	if( CL_IsActive() && EngFuncs::GetCvarFloat( "host_serverstate" ) && EngFuncs::GetCvarFloat( "maxplayers" ) == 1.0f )
		dialog.SetMessage( L( "StringsList_235" ) );
	else
		dialog.SetMessage( L( "GameUI_QuitConfirmationText" ) );

	dialog.onPositive.SetCommand( false, "quit \"menu dialog\"\n" );
	dialog.Show();
}

void CMenuMain::DisconnectCb()
{
	EngFuncs::ClientCmd( false, "disconnect\n" );
	VidInit( false );
#if !defined( __EMSCRIPTEN__ )
	H9LinkPlace();
#endif
	CalcPosition();
	CalcSizes();
	VidInitItems();
}

void CMenuMain::DisconnectDialogCb()
{
	dialog.onPositive = VoidCb( &CMenuMain::DisconnectCb );
	dialog.SetMessage( L( "Really disconnect?" ) );
	dialog.Show();
}

void CMenuMain::HazardCourseDialogCb()
{
	dialog.onPositive = VoidCb( &CMenuMain::HazardCourseCb );;
	dialog.SetMessage( L( "StringsList_234" ) );
	dialog.Show();
}

#if !defined( __EMSCRIPTEN__ )
// H9: not linked, the link dialog; linked, the question first
void CMenuMain::H9LinkCb()
{
	static char question[256];

	if( EngFuncs::GetCvarString( "_h9lnk" )[0] != '1' )
	{
		h9linkDialog.Open();
		return;
	}

	snprintf( question, sizeof( question ), "%s %s %s %s?\n\n%s",
		L( "Unlink this game from account" ), EngFuncs::GetCvarString( "_h9link_account" ), L( "on" ),
		EngFuncs::GetCvarString( "_h9link_site" ), L( "It gets a new id, and plays as a guest until you link it again." ));
	dialog.onPositive.SetCommand( false, "h9_unlink\n" );
	dialog.SetMessage( question );
	dialog.Show();
}

// H9: the column, as VidInit lays it out, makes room for Link your Account in the row above Quit,
// directly below Change Game: every button above that row moves up one. An engine without the
// link (no _h9lnk) keeps the column as it is. Buttons this menu does not show keep their places.
void CMenuMain::H9LinkPlace()
{
	const int ygap = (( 404 - 373 ) / 480.0 ) * 768.0;
	CMenuBaseItem *column[] = { &console, &resumeGame, &disconnect, &newGame, &configuration, &saveRestore, &multiPlayer, &previews,
		bTrainMap ? &hazardCourse : NULL, bCustomGame ? &customGame : NULL };

	if( !EngFuncs::GetCvarString( "_h9lnk" )[0] )
		return;

	for( CMenuBaseItem *item : column )
	{
		// the console button is placed whether it shows or not: developer shows it later
		if( item && ( item->IsVisible() || item == &console ) && item->pos.y < quit.pos.y )
			item->pos.y -= ygap;
	}
	h9link.SetCoord( quit.pos.x, quit.pos.y - ygap );
}
#endif

/*
=================
CMenuMain::Key
=================
*/
bool CMenuMain::KeyDown( int key )
{
	if( UI::Key::IsEscape( key ) )
	{
		if ( CL_IsActive( ))
		{
			if( !dialog.IsVisible() )
				UI_CloseMenu();
		}
		else
		{
			QuitDialogCb( );
		}
		return true;
	}
	return CMenuFramework::KeyDown( key );
}

/*
=================
UI_Main_HazardCourse
=================
*/
void CMenuMain::HazardCourseCb()
{
	if( EngFuncs::GetCvarFloat( "host_serverstate" ) && EngFuncs::GetCvarFloat( "maxplayers" ) > 1 )
		EngFuncs::HostEndGame( "end of the game" );

	EngFuncs::CvarSetValue( "skill", 1.0f );
	EngFuncs::CvarSetValue( "deathmatch", 0.0f );
	EngFuncs::CvarSetValue( "teamplay", 0.0f );
	EngFuncs::CvarSetValue( "pausable", 1.0f ); // singleplayer is always allowing pause
	EngFuncs::CvarSetValue( "coop", 0.0f );
	EngFuncs::CvarSetValue( "maxplayers", 1.0f ); // singleplayer

	EngFuncs::PlayBackgroundTrack( NULL, NULL );

	EngFuncs::ClientCmd( false, "hazardcourse\n" );
}

void CMenuMain::_Init( void )
{
	if( gMenu.m_gameinfo.trainmap[0] && stricmp( gMenu.m_gameinfo.trainmap, gMenu.m_gameinfo.startmap ) != 0 )
		bTrainMap = true;
	else bTrainMap = false;

	if( EngFuncs::GetCvarFloat( "host_allow_changegame" ))
		bCustomGame = true;
	else bCustomGame = false;

	// console
	console.SetNameAndStatus( L( "GameUI_Console" ), L( "Show console" ) );
	console.iFlags |= QMF_NOTIFY;
	console.SetPicture( PC_CONSOLE );
	console.SetVisibility( gpGlobals->developer );
	SET_EVENT_MULTI( console.onReleased,
	{
		UI_SetActiveMenu( false );
		EngFuncs::KEY_SetDest( KEY_CONSOLE );
	});

	resumeGame.SetNameAndStatus( L( "GameUI_GameMenu_ResumeGame" ), L( "StringsList_188" ) );
	resumeGame.SetPicture( PC_RESUME_GAME );
	resumeGame.iFlags |= QMF_NOTIFY;
	resumeGame.onReleased = UI_CloseMenu;

	disconnect.SetNameAndStatus( L( "GameUI_GameMenu_Disconnect" ), L( "Disconnect from server" ) );
	disconnect.SetPicture( PC_DISCONNECT );
	disconnect.iFlags |= QMF_NOTIFY;
	disconnect.onReleased = VoidCb( &CMenuMain::DisconnectDialogCb );

	newGame.SetNameAndStatus( L( "GameUI_NewGame" ), L( "StringsList_189" ) );
	newGame.SetPicture( PC_NEW_GAME );
	newGame.iFlags |= QMF_NOTIFY;
	newGame.onReleased = UI_NewGame_Menu;

	hazardCourse.SetNameAndStatus( L( "GameUI_TrainingRoom" ), L( "StringsList_190" ) );
	hazardCourse.SetPicture( PC_HAZARD_COURSE );
	hazardCourse.iFlags |= QMF_NOTIFY;
	hazardCourse.onReleasedClActive = VoidCb( &CMenuMain::HazardCourseDialogCb );
	hazardCourse.onReleased = VoidCb( &CMenuMain::HazardCourseCb );

	multiPlayer.SetNameAndStatus( L( "GameUI_Multiplayer" ), L( "StringsList_198" ) );
	multiPlayer.SetPicture( PC_MULTIPLAYER );
	multiPlayer.iFlags |= QMF_NOTIFY;
	multiPlayer.onReleased = UI_MultiPlayer_Menu;

	configuration.SetNameAndStatus( L( "GameUI_Options" ), L( "StringsList_193" ) );
	configuration.SetPicture( PC_CONFIG );
	configuration.iFlags |= QMF_NOTIFY;
	configuration.onReleased = UI_Options_Menu;

	saveRestore.iFlags |= QMF_NOTIFY;

	customGame.SetNameAndStatus( L( "GameUI_ChangeGame" ), L( "StringsList_530" ) );
	customGame.SetPicture( PC_CUSTOM_GAME );
	customGame.iFlags |= QMF_NOTIFY;
	customGame.onReleased = UI_CustomGame_Menu;

	previews.SetNameAndStatus( L( "Previews" ), L( "StringsList_400" ) );
	previews.SetPicture( PC_PREVIEWS );
	previews.iFlags |= QMF_NOTIFY;
	SET_EVENT( previews.onReleased, EngFuncs::ShellExecute( MenuStrings[ IDS_MEDIA_PREVIEWURL ], NULL, false ) );

	quit.SetNameAndStatus( L( "GameUI_GameMenu_Quit" ), L( "GameUI_QuitConfirmationText" ) );
	quit.SetPicture( PC_QUIT );
	quit.iFlags |= QMF_NOTIFY;
	quit.onReleased = VoidCb( &CMenuMain::QuitDialogCb );

	quitButton.SetPicture( ART_CLOSEBTN_N, ART_CLOSEBTN_F, ART_CLOSEBTN_D );
	quitButton.iFlags = QMF_MOUSEONLY;
	quitButton.eFocusAnimation = QM_HIGHLIGHTIFFOCUS;
	quitButton.onReleased = VoidCb( &CMenuMain::QuitDialogCb );

	minimizeBtn.SetPicture( ART_MINIMIZE_N, ART_MINIMIZE_F, ART_MINIMIZE_D );
	minimizeBtn.iFlags = QMF_MOUSEONLY;
	minimizeBtn.eFocusAnimation = QM_HIGHLIGHTIFFOCUS;
	minimizeBtn.onReleased.SetCommand( false, "minimize\n" );

	if ( gMenu.m_gameinfo.gamemode == GAME_MULTIPLAYER_ONLY || gMenu.m_gameinfo.startmap[0] == 0 )
		newGame.SetGrayed( true );

	if ( gMenu.m_gameinfo.gamemode == GAME_SINGLEPLAYER_ONLY )
		multiPlayer.SetGrayed( true );

	if ( gMenu.m_gameinfo.gamemode == GAME_MULTIPLAYER_ONLY )
	{
		saveRestore.SetGrayed( true );
		hazardCourse.SetGrayed( true );
	}

	// too short execute string - not a real command
	if( strlen( MenuStrings[IDS_MEDIA_PREVIEWURL] ) <= 3 )
	{
		previews.SetGrayed( true );
	}

	// server.dll needs for reading savefiles or startup newgame
	if( !EngFuncs::CheckGameDll( ))
	{
		saveRestore.SetGrayed( true );
		hazardCourse.SetGrayed( true );
		newGame.SetGrayed( true );
	}

	if( FBitSet( gMenu.m_gameinfo.flags, GFL_ANIMATED_TITLE ))
	{
		if( animatedBanner.TryLoad())
			AddItem( animatedBanner );
	}
	else
	{
		AddItem( movieBanner );
	}

	dialog.Link( this );

	AddItem( banner );
	AddItem( console );
	AddItem( disconnect );
	AddItem( resumeGame );
	AddItem( newGame );

	if ( bTrainMap )
		AddItem( hazardCourse );

	AddItem( configuration );
	AddItem( saveRestore );
	AddItem( multiPlayer );

	if ( bCustomGame )
		AddItem( customGame );

	AddItem( previews );
	AddItem( quit );
	AddItem( minimizeBtn );
	AddItem( quitButton );

#if !defined( __EMSCRIPTEN__ )
	// H9: Link your Account / Unlink your Account (CMenuH9LinkButton above); hidden until the engine
	// says, placed by H9LinkPlace
	h9link.SetNameAndStatus( L( "Link your Account" ), L( "Link this game to your havoc9.org account" ));
	h9link.iFlags |= QMF_NOTIFY;
	h9link.onReleased = VoidCb( &CMenuMain::H9LinkCb );
	h9link.Hide();
	h9linkDialog.Link( this );
	AddItem( h9link );
#endif
}

/*
=================
UI_Main_Init
=================
*/
void CMenuMain::VidInit( bool connected )
{
	int hoffset = ( 70 / 640.0 ) * 1024.0;

	// in original menu Previews is located at specific point
	int previews_voffset = ( 404 / 480.0 ) * 768.0;

	// no visible console button gap
	int ygap = (( 404 - 373 ) / 480.0 ) * 768.0;

	// statically positioned items
	minimizeBtn.SetRect( uiStatic.width - 72, 13, 32, 32 );
	quitButton.SetRect( uiStatic.width - 36, 13, 32, 32 );

	// A game that is played on servers only has nothing to start or load, and Previews is an
	// advertisement of Half-Life's publisher: such a game's menu leaves the three out.
	const bool onlyMulti = gMenu.m_gameinfo.gamemode == GAME_MULTIPLAYER_ONLY;

	previews.SetCoord( hoffset, previews_voffset );
	quit.SetCoord( hoffset, previews_voffset + ygap );

	// let's start calculating positions
	int yoffset = onlyMulti ? previews_voffset : previews_voffset - ygap;

	if( bCustomGame )
	{
		customGame.SetCoord( hoffset, yoffset );
		yoffset -= ygap;
	}

	multiPlayer.SetCoord( hoffset, yoffset );
	yoffset -= ygap;

	bool single = gpGlobals->maxClients < 2;

	if( !onlyMulti )
	{
		saveRestore.SetCoord( hoffset, yoffset );
		yoffset -= ygap;
	}

	configuration.SetCoord( hoffset, yoffset );
	yoffset -= ygap;

	if( bTrainMap )
	{
		hazardCourse.SetCoord( hoffset, yoffset );
		yoffset -= ygap;
	}

	if( !onlyMulti )
	{
		newGame.SetCoord( hoffset, yoffset );
		yoffset -= ygap;
	}

	if( connected )
	{
		resumeGame.SetCoord( hoffset, yoffset );
		yoffset -= ygap;

		if( !single )
		{
			disconnect.SetCoord( hoffset, yoffset );
			yoffset -= ygap;
		}
	}

	console.SetCoord( hoffset, yoffset );
	yoffset -= ygap;

	// now figure out what's visible
	resumeGame.SetVisibility( connected );
	newGame.SetVisibility( !onlyMulti );
	saveRestore.SetVisibility( !onlyMulti );
	previews.SetVisibility( !onlyMulti );
	disconnect.SetVisibility( connected && !single );

	if( connected && single )
	{
		saveRestore.SetNameAndStatus( L( "Save\\Load Game" ), L( "StringsList_192" ) );
		saveRestore.SetPicture( PC_SAVE_LOAD_GAME );
		saveRestore.onReleased = UI_SaveLoad_Menu;
	}
	else
	{
		saveRestore.SetNameAndStatus( L( "GameUI_LoadGame" ), L( "StringsList_191" ) );
		saveRestore.SetPicture( PC_LOAD_GAME );
		saveRestore.onReleased = UI_LoadGame_Menu;
	}
}

void CMenuMain::_VidInit()
{
	VidInit( CL_IsActive() );
#if !defined( __EMSCRIPTEN__ )
	H9LinkPlace();
#endif
}

void CMenuMain::Think()
{
	if( gpGlobals->developer )
	{
		if( !console.IsVisible( ))
			console.Show();
	}
	else
	{
		if( console.IsVisible( ))
			console.Hide();
	}

	CMenuFramework::Think();
}

ADD_MENU( menu_main, CMenuMain, UI_Main_Menu );

/*
=================
UI_QuitDialog_f

called by the engine when the OS asks to quit (window close button, Cmd+Q on macOS...)
=================
*/
static void UI_QuitDialog_f( void )
{
	// nothing to lose, quit immediately
	if( !CL_IsActive( ))
	{
		EngFuncs::ClientCmd( false, "quit \"menu\"\n" );
		return;
	}

	if( !UI_IsVisible( ))
		UI_Main_Menu();

	menu_main->QuitDialogCb();
}
ADD_COMMAND( menu_quit, UI_QuitDialog_f );
