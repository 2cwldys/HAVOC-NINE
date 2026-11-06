/*
ConnectionProgress.cpp -- connection progress window
Copyright (C) 2017 mittorn

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

H9: the join screen (mainui-h9-joinscreen.patch), which the engine's cl_h9join.c brings up when a join
starts (connect, retry, this game's own server) and at each map change, and takes down once the player
is in the game. Over the menu's own background, or its video, full screen: a panel in the menu's colours
(gfx/shell/colors.lst: H9's purple) with the server it joins, the stage, the overall bar (scr_loading),
and while a file downloads the downloads together (the bytes done and to go, the time left) and the file's
line (the name, n of N, KB of KB) with its own bar. The engine keeps all of it in read-only cvars (_h9join,
_h9join_server, _h9join_stage, _h9join_total, _h9join_file, _h9join_fileprog), read here each frame. CANCEL, or ESC, ends the join at once; the console key opens the console in its place.
A join, or a game, that ends with a reason (_h9_drop: refused, kicked, timed out, a file that could not
come) says it, with OK, over the menu's own screens.
*/
#include "extdll_menu.h"
#include "BaseMenu.h"
#include "Utils.h"

#include "ItemsHolder.h"
#include "ProgressBar.h"
#include "PicButton.h"
#include "YesNoMessageBox.h"

#define JOIN_W 640
#define JOIN_H 240

class CMenuConnectionProgress : public CMenuBaseWindow
{
public:
	CMenuConnectionProgress();
	void _Init() override;
	void _VidInit() override;
	void Draw() override;
	bool DrawAnimation() override;
	bool KeyDown( int key ) override;

	void Begin();
	void End();

private:
	void Cancel();
	void Refresh();

	CMenuBackgroundBitmap fullBackground; // the menu's own background, full screen (no parent: the whole screen)
	CMenuBackgroundBitmap panel;          // the panel, in the dialog colour
	CMenuAction title;
	CMenuAction stage;
	CMenuAction totalLine;
	CMenuAction fileLine;
	CMenuProgressBar overall;
	CMenuProgressBar fileBar;
	CMenuPicButton cancelButton;
	char sTitle[256];
	char sStage[128];
	char sTotal[160];
	char sFile[512];
};

CMenuConnectionProgress::CMenuConnectionProgress() : CMenuBaseWindow( "ConnectionProgress" )
{
	sTitle[0] = sStage[0] = sTotal[0] = sFile[0] = '\0';
	szName = "ConnectionProgress";
}

bool CMenuConnectionProgress::KeyDown( int key )
{
	if( UI::Key::IsEscape( key ))
	{
		PlayLocalSound( uiStatic.sounds[SND_OUT] );
		Cancel();
		return true;
	}
	if( UI::Key::IsConsole( key ))
	{
		// the console in the screen's place, as upstream shows it: the join goes on. UI_CloseMenu takes
		// every window down, this one with them
		PlayLocalSound( uiStatic.sounds[SND_LAUNCH] );
		UI_CloseMenu();
		UI_SetActiveMenu( false );
		EngFuncs::KEY_SetDest( KEY_CONSOLE );
		return true;
	}

	return CMenuItemsHolder::KeyDown( key );
}

// CANCEL or ESC: the join ends here; the engine's disconnect brings the menu's own screens back (End)
void CMenuConnectionProgress::Cancel()
{
	EngFuncs::ClientCmd( true, "http_clear\n" );
	EngFuncs::ClientCmd( false, "disconnect\n" );
}

// a join or a map change: the screen, on top of whatever the menu shows. With the menu down (a join from
// the console, a map change in the game) the main menu goes under it first: the menu's last window never
// closes, so the screen alone could never hide, and a join that ends before the game ends on the main menu
void CMenuConnectionProgress::Begin()
{
	Refresh();
	if( !UI_IsVisible( ))
		UI_Main_Menu();
	if( !IsVisible( ))
		Show();
}

// the box a refusal for an out-of-date game gets: the server's own words, and a button that opens the page they name (a click only)
static void OpenDownloadsPage( void )
{
	EngFuncs::ShellExecute( "https://havoc9.org/downloads/", NULL, false );
}

static void ShowUpdateBox( const char *reason )
{
	static char msg[512];
	static CMenuYesNoMessageBox box( false );
	static bool init;

	Q_strncpy( msg, reason, sizeof( msg ));

	if( !UI_IsVisible( ))
	{
		UI_Main_Menu();
		UI_SetActiveMenu( true );
	}

	if( !init )
	{
		box.SetPositiveButton( L( "Open havoc9.org" ), PC_OK, 100 );
		box.SetNegativeButton( L( "Close" ), PC_CANCEL, -20 );
		box.onPositive = OpenDownloadsPage;
		init = true;
	}

	box.SetMessage( msg );
	box.Show();
}

// the join is over before the game: the menu's own screens again, and the reason when the engine has one
void CMenuConnectionProgress::End()
{
	const char *reason = EngFuncs::GetCvarString( "_h9_drop" );

	if( IsVisible( ))
		Hide();
	if( reason && reason[0] )
	{
		if( strstr( reason, "havoc9.org/downloads" ))
			ShowUpdateBox( reason );
		else UI_ShowMessageBox( reason );
	}
}

void CMenuConnectionProgress::_Init( void )
{
	iFlags |= QMF_DIALOG;

	panel.bForceColor = true;
	panel.colorBase = uiPromptBgColor;
	panel.bDrawStroke = true;
	panel.colorStroke = uiInputFgColor;

	title.iFlags = QMF_INACTIVE|QMF_DROPSHADOW;
	title.eTextAlignment = QM_CENTER;
	title.szName = sTitle;

	stage.iFlags = QMF_INACTIVE;
	stage.eTextAlignment = QM_CENTER;
	stage.szName = sStage;

	totalLine.iFlags = QMF_INACTIVE;
	totalLine.eTextAlignment = QM_CENTER;
	totalLine.szName = sTotal;

	fileLine.iFlags = QMF_INACTIVE;
	fileLine.eTextAlignment = QM_CENTER;
	fileLine.szName = sFile;

	overall.LinkCvar( "scr_loading", 0.0f, 100.0f );
	fileBar.LinkCvar( "_h9join_fileprog", 0.0f, 100.0f );

	cancelButton.SetPicture( PC_CANCEL );
	cancelButton.szName = L( "GameUI_Cancel" );
	cancelButton.onReleased = VoidCb( &CMenuConnectionProgress::Cancel );
	cancelButton.bEnableTransitions = false;

	AddItem( panel );
	AddItem( title );
	AddItem( stage );
	AddItem( overall );
	AddItem( totalLine );
	AddItem( fileLine );
	AddItem( fileBar );
	AddItem( cancelButton );
}

void CMenuConnectionProgress::_VidInit( void )
{
	SetRect( ( 1024 - JOIN_W ) / 2, ( 768 - JOIN_H ) / 2, JOIN_W, JOIN_H );
	pos.x += uiStatic.xOffset;
	pos.y += uiStatic.yOffset;

	fullBackground.VidInit();

	title.SetCharSize( QM_DEFAULTFONT );
	title.SetRect( 0, 18, JOIN_W, 24 );

	stage.SetCharSize( QM_SMALLFONT );
	stage.SetRect( 0, 56, JOIN_W, 20 );

	overall.SetRect( 20, 86, JOIN_W - 40, 20 );

	totalLine.SetCharSize( QM_SMALLFONT );
	totalLine.SetRect( 0, 108, JOIN_W, 18 );

	fileLine.SetCharSize( QM_SMALLFONT );
	fileLine.SetRect( 0, 128, JOIN_W, 20 );

	fileBar.SetRect( 20, 152, JOIN_W - 40, 12 );

	cancelButton.SetRect( ( JOIN_W - UI_BUTTONS_WIDTH / 2 ) / 2, JOIN_H - 50, UI_BUTTONS_WIDTH / 2, UI_BUTTONS_HEIGHT );

	CalcPosition();
	CalcSizes();
}

bool CMenuConnectionProgress::DrawAnimation()
{
	// We don't have animation
	return true;
}

// the engine's word, each frame
void CMenuConnectionProgress::Refresh( void )
{
	const char *server = EngFuncs::GetCvarString( "_h9join_server" );
	const char *what = EngFuncs::GetCvarString( "_h9join_stage" );
	const char *file = EngFuncs::GetCvarString( "_h9join_file" );
	const char *total = EngFuncs::GetCvarString( "_h9join_total" );

	snprintf( sTitle, sizeof( sTitle ), "%s", server && server[0] ? server : L( "GameUI_EstablishingConnection" ));
	snprintf( sStage, sizeof( sStage ), "%s", what && what[0] ? what : L( "GameUI_EstablishingConnection" ));
	snprintf( sFile, sizeof( sFile ), "%s", file ? file : "" );
	snprintf( sTotal, sizeof( sTotal ), "%s", total ? total : "" );

	if( sTotal[0] )
		totalLine.Show();
	else totalLine.Hide();

	if( sFile[0] )
	{
		fileLine.Show();
		fileBar.Show();
	}
	else
	{
		fileLine.Hide();
		fileBar.Hide();
	}
}

void CMenuConnectionProgress::Draw( void )
{
	// the screen goes as the engine takes it down: the game is in, or the join is over
	if( !EngFuncs::GetCvarFloat( "_h9join" ))
	{
		Hide();
		return;
	}
	Refresh();
	fullBackground.Draw();
	CMenuBaseWindow::Draw();
}

ADD_MENU3( menu_connectionprogress, CMenuConnectionProgress, UI_ConnectionProgress_f );

// the engine's hooks (UI_EXTENDED_FUNCTIONS): a join's start and a map change bring the screen up, a join's
// end takes it down; everything in between the engine says in its cvars
void UI_ConnectionProgress_Disconnect( void )
{
	menu_connectionprogress->End();
}

void UI_ConnectionProgress_Download( const char *pszFileName, const char *pszServerName, int iCurrent, int iTotal, const char *comment )
{
	if( strstr( pszFileName, ".bsp" ))
		uiStatic.needMapListUpdate = true;
}

void UI_ConnectionProgress_DownloadEnd( void )
{
}

void UI_ConnectionProgress_Precache( void )
{
}

void UI_ConnectionProgress_Connect( const char *server ) // NULL for local server
{
	menu_connectionprogress->Begin();
}

void UI_ConnectionProgress_ChangeLevel( void )
{
	menu_connectionprogress->Begin();
}

void UI_ConnectionProgress_ParseServerInfo( const char *server )
{
}

void UI_ConnectionProgress_f( void )
{
	if( !strcmp( EngFuncs::CmdArgv( 1 ), "disconnect" ))
		UI_ConnectionProgress_Disconnect();
	else if( !strcmp( EngFuncs::CmdArgv( 1 ), "menu" ) || !strcmp( EngFuncs::CmdArgv( 1 ), "changelevel" ))
		menu_connectionprogress->Begin();
}
