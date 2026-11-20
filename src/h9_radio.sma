/*
 * h9_radio -- the music channel: local ambient tracks and internet radio, one owner.
 *
 * The engine half this needs is not in the patch chain yet -- see
 * xash3d-h9-patches/pending/engine-h9-radio. Until it is applied every /radio command
 * works and a station URL plays nothing, because the engine cannot open one.
 *
 * Why one plugin owns both
 * -----------------------
 * There is exactly one background music channel in the engine. S_StartBackgroundTrack()
 * calls S_StopBackgroundTrack() as its first line, so whoever starts a track silently kills
 * whatever was playing. Today the ambient rotation in ts_matchmode.sma drives that channel.
 * If a radio plugin drove it too, the two would fight: the ambient scheduler would fire on
 * its timer and cut the radio off mid-song.
 *
 * So this plugin is the single owner. Each player has one music source:
 *
 *     SRC_OFF      nothing
 *     SRC_AMBIENT  the local track rotation, from sound/music
 *     SRC_RADIO    an http/https mp3 stream
 *
 * Switching source is one client command either way, because the engine treats a URL as just
 * another stream format (see ..\engine\snd_http.c and ..\engine\hooks.md):
 *
 *     mp3 play sound/music/rachels_song.mp3      -- ambient
 *     mp3 play https://host:8061/listen.mp3      -- radio
 *     mp3 stop                                   -- silence
 *
 * Turning the radio on therefore interrupts the ambience by construction, not by bookkeeping.
 *
 * Handover from ts_matchmode
 * --------------------------
 * ts_matchmode.sma already has the rotation (g_music_mp3 / g_music_len / task_music_queue,
 * around lines 868 and 29699-30026). While h9_radio_ambient is 1 this plugin drives the
 * channel and ts_matchmode must not. See ..\engine\hooks.md for the one-line gate.
 * Set h9_radio_ambient 0 to hand the rotation back and keep only the radio half.
 *
 * Stock behaviour
 * ---------------
 * h9_radio defaults to 0: the plugin registers its commands, says the feature is off, and
 * touches nothing. The server is stock TS until someone sets it.
 */

#include <amxmodx>
#include <amxmisc>

#define PLUGIN  "H9 Radio"
#define VERSION "0.1"
#define AUTHOR  "HAVOC 9"

// Player slots, the same convention ts_matchmode uses: AMX Mod X's MAX_PLAYERS, which
// get_players() buffers must match. H9's AMX Mod X build sets it to 128, the stock include
// has 32. Per-player tables are MAXPL long (slot 0 unused); a "is this a player" test is
// against g_maxplayers, never MAXPL.
#define RADIO_SLOTS    MAX_PLAYERS
#define MAXPL          (RADIO_SLOTS + 1)

#define MAX_STATIONS   24
#define MAX_URL        160
#define MAX_NAME       32
#define TASK_AMBIENT   91400

enum
{
	SRC_OFF = 0,
	SRC_AMBIENT,
	SRC_RADIO
};

// ---------------------------------------------------------------- stations

new g_station_name[MAX_STATIONS][MAX_NAME];
new g_station_url[MAX_STATIONS][MAX_URL];
new g_stations;

// ---------------------------------------------------------------- ambient rotation
// The same sixteen tracks ts_matchmode plays, with the same lengths. If a track is added
// there it must be added here, or the rotation here will not know about it.

new const g_music_mp3[][] =
{
	"itsadream.mp3", "ihateher.mp3", "fivefingers.mp3", "deadinsects.mp3",
	"twoplustwo.mp3", "contaminated.wav", "vangelis.wav", "floatingmuseum.mp3",
	"grammaton_cleric.mp3", "burned.mp3", "supression.mp3", "alwaysknew.mp3",
	"equilibrium_suite.mp3", "equilibrium_final_countdown.mp3", "prophecy_theme.mp3",
	"rachels_song.mp3"
};

new const Float:g_music_len[] =
{
	70.1, 73.7, 42.2, 107.5, 42.2, 304.0, 618.8, 305.6,
	78.5, 129.9, 147.9, 306.9, 1105.2, 858.0, 261.3, 288.0
};

new bool:g_music_played[sizeof g_music_mp3];
new g_music_cur = -1;

// ---------------------------------------------------------------- per player

new g_source[MAXPL];
new g_tuned[MAXPL];                  // index into g_station_*, or -1 for a custom url
new g_custom[MAXPL][MAX_URL];

new g_maxplayers;

// ---------------------------------------------------------------- cvars
// AMXX cvar change hooks do not fire reliably in this build (hook_cvar_change and
// bind_pcvar both stay silent), so these are read where they are used, never cached.

new cvar_enabled;
new cvar_ambient;
new cvar_default;
new cvar_volume;

public plugin_init()
{
	register_plugin( PLUGIN, VERSION, AUTHOR );

	cvar_enabled = register_cvar( "h9_radio", "0" );          // 0 = stock: this plugin does nothing
	cvar_ambient = register_cvar( "h9_radio_ambient", "1" );  // 1 = this plugin drives the rotation
	cvar_default = register_cvar( "h9_radio_default", "" );   // station tuned for a joining player
	cvar_volume  = register_cvar( "h9_radio_volume", "0.8" ); // applied client side as MP3volume

	register_clcmd( "say",      "cmd_say" );
	register_clcmd( "say_team", "cmd_say" );

	register_concmd( "h9_radio_reload", "cmd_reload", ADMIN_CFG, "reload the station list" );

	g_maxplayers = get_maxplayers();

	load_stations();
}

public plugin_cfg()
{
	// AMXX only runs amxx.cfg by itself: this plugin runs its own cfg, before the switches below
	// are read, so what h9_radio.cfg sets is what the map starts with
	new cfgdir[64], cfgfile[160];
	get_configsdir( cfgdir, charsmax( cfgdir ));
	formatex( cfgfile, charsmax( cfgfile ), "%s/h9_radio.cfg", cfgdir );
	if( file_exists( cfgfile ))
	{
		server_cmd( "exec %s", cfgfile );
		server_exec();
	}

	if( !get_pcvar_num( cvar_enabled ))
		return;

	if( get_pcvar_num( cvar_ambient ))
		set_task( 5.0, "task_ambient", TASK_AMBIENT );
}

// ---------------------------------------------------------------- station list

load_stations()
{
	new path[128], line[256], name[MAX_NAME], url[MAX_URL];

	g_stations = 0;

	get_configsdir( path, charsmax( path ));
	format( path, charsmax( path ), "%s/h9_radio_stations.ini", path );

	new f = fopen( path, "rt" );

	if( !f )
	{
		log_amx( "[H9RADIO] no station list at %s", path );
		return;
	}

	while( !feof( f ) && g_stations < MAX_STATIONS )
	{
		fgets( f, line, charsmax( line ));
		trim( line );

		if( !line[0] || line[0] == ';' || ( line[0] == '/' && line[1] == '/' ))
			continue;

		// name|url
		new pipe = contain( line, "|" );

		if( pipe < 1 )
			continue;

		copy( name, charsmax( name ), line );
		name[pipe] = 0;
		trim( name );

		copy( url, charsmax( url ), line[pipe + 1] );
		trim( url );

		if( !name[0] || !url[0] )
			continue;

		// only http and https reach the engine's stream opener
		if( !equali( url, "http://", 7 ) && !equali( url, "https://", 8 ))
		{
			log_amx( "[H9RADIO] skipping %s: not an http or https url", name );
			continue;
		}

		copy( g_station_name[g_stations], charsmax( g_station_name[] ), name );
		copy( g_station_url[g_stations], charsmax( g_station_url[] ), url );
		g_stations++;
	}

	fclose( f );
	log_amx( "[H9RADIO] %d station(s) loaded", g_stations );
}

public cmd_reload( id, level, cid )
{
	if( !cmd_access( id, level, cid, 1 ))
		return PLUGIN_HANDLED;

	load_stations();
	console_print( id, "[H9RADIO] %d station(s) loaded.", g_stations );
	return PLUGIN_HANDLED;
}

// ---------------------------------------------------------------- joining and leaving

public client_putinserver( id )
{
	g_source[id] = SRC_OFF;
	g_tuned[id]  = -1;
	g_custom[id][0] = 0;

	if( !get_pcvar_num( cvar_enabled ))
		return;

	// A bot has no client: client_cmd goes nowhere and the engine never sees it.
	if( is_user_bot( id ) || is_user_hltv( id ))
		return;

	new def[MAX_NAME];
	get_pcvar_string( cvar_default, def, charsmax( def ));
	trim( def );

	if( def[0] )
	{
		new idx = find_station( def );

		if( idx != -1 )
		{
			set_task( 3.0, "task_tune_default", id );
			return;
		}
	}

	if( get_pcvar_num( cvar_ambient ))
		set_task( 3.0, "task_join_ambient", id );
}

public task_tune_default( id )
{
	if( !is_user_connected( id ))
		return;

	new def[MAX_NAME];
	get_pcvar_string( cvar_default, def, charsmax( def ));
	trim( def );

	new idx = find_station( def );

	if( idx != -1 )
		tune_station( id, idx, false );
}

public task_join_ambient( id )
{
	if( !is_user_connected( id ))
		return;

	start_ambient_for( id );
}

public client_disconnected( id )
{
	g_source[id] = SRC_OFF;
	g_tuned[id]  = -1;
	g_custom[id][0] = 0;
}

// ---------------------------------------------------------------- chat

public cmd_say( id )
{
	new said[192];
	read_args( said, charsmax( said ));
	remove_quotes( said );
	trim( said );

	if( !equali( said, "/radio", 6 ))
		return PLUGIN_CONTINUE;

	// "/radiostuff" is not our command
	if( said[6] && said[6] != ' ' )
		return PLUGIN_CONTINUE;

	if( !get_pcvar_num( cvar_enabled ))
	{
		client_print( id, print_chat, "[H9] The radio is off on this server." );
		return PLUGIN_HANDLED;
	}

	if( is_user_bot( id ))
		return PLUGIN_HANDLED;

	new arg[MAX_URL];
	copy( arg, charsmax( arg ), said[6] );
	trim( arg );

	if( !arg[0] || equali( arg, "help" ))
	{
		show_help( id );
		return PLUGIN_HANDLED;
	}

	if( equali( arg, "off" ) || equali( arg, "stop" ))
	{
		radio_off( id );
		return PLUGIN_HANDLED;
	}

	if( equali( arg, "on" ))
	{
		// "on" with nothing tuned picks the first station, or the server default
		new idx = ( g_tuned[id] != -1 ) ? g_tuned[id] : 0;

		if( g_stations < 1 )
		{
			client_print( id, print_chat, "[H9] No stations are set up." );
			return PLUGIN_HANDLED;
		}

		tune_station( id, idx, true );
		return PLUGIN_HANDLED;
	}

	if( equali( arg, "ambient" ) || equali( arg, "music" ))
	{
		start_ambient_for( id );
		client_print( id, print_chat, "[H9] Ambient music on." );
		return PLUGIN_HANDLED;
	}

	if( equali( arg, "list" ))
	{
		show_list( id );
		return PLUGIN_HANDLED;
	}

	// /radio url <url> -- affects only the player who typed it
	if( equali( arg, "url ", 4 ))
	{
		new url[MAX_URL];
		copy( url, charsmax( url ), arg[4] );
		trim( url );

		if( !equali( url, "http://", 7 ) && !equali( url, "https://", 8 ))
		{
			client_print( id, print_chat, "[H9] That is not an http or https address." );
			return PLUGIN_HANDLED;
		}

		tune_url( id, url );
		return PLUGIN_HANDLED;
	}

	// a number, or a station name
	new idx = -1;

	if( is_str_num( arg ))
	{
		new n = str_to_num( arg );

		if( n >= 1 && n <= g_stations )
			idx = n - 1;
	}
	else idx = find_station( arg );

	if( idx == -1 )
	{
		client_print( id, print_chat, "[H9] No station called '%s'. Say /radio list", arg );
		return PLUGIN_HANDLED;
	}

	tune_station( id, idx, true );
	return PLUGIN_HANDLED;
}

show_help( id )
{
	client_print( id, print_chat, "[H9] /radio on  /radio off  /radio list  /radio <name>" );
	client_print( id, print_chat, "[H9] /radio ambient returns to the server's music." );

	if( g_source[id] == SRC_RADIO )
	{
		new label[MAX_URL];
		current_label( id, label, charsmax( label ));
		client_print( id, print_chat, "[H9] Now playing: %s", label );
	}
	else if( g_source[id] == SRC_AMBIENT )
		client_print( id, print_chat, "[H9] Now playing: ambient music" );
	else
		client_print( id, print_chat, "[H9] Nothing is playing." );
}

show_list( id )
{
	if( g_stations < 1 )
	{
		client_print( id, print_chat, "[H9] No stations are set up." );
		return;
	}

	client_print( id, print_chat, "[H9] Stations:" );

	for( new i = 0; i < g_stations; i++ )
		client_print( id, print_chat, "[H9] %d. %s%s", i + 1, g_station_name[i],
			( g_source[id] == SRC_RADIO && g_tuned[id] == i ) ? " (playing)" : "" );
}

find_station( const name[] )
{
	for( new i = 0; i < g_stations; i++ )
	{
		if( equali( name, g_station_name[i] ))
			return i;
	}

	return -1;
}

current_label( id, out[], len )
{
	if( g_tuned[id] >= 0 && g_tuned[id] < g_stations )
		copy( out, len, g_station_name[g_tuned[id]] );
	else
		copy( out, len, g_custom[id] );
}

// ---------------------------------------------------------------- the music channel
//
// One command starts either source. The engine stops whatever was playing first, so there
// is nothing to tear down by hand.

set_volume( id )
{
	new Float:vol = get_pcvar_float( cvar_volume );

	if( vol < 0.0 ) vol = 0.0;
	if( vol > 1.0 ) vol = 1.0;

	client_cmd( id, "MP3Volume %f", vol );
}

tune_station( id, idx, bool:announce )
{
	if( idx < 0 || idx >= g_stations )
		return;

	g_source[id] = SRC_RADIO;
	g_tuned[id]  = idx;
	g_custom[id][0] = 0;

	set_volume( id );
	client_cmd( id, "mp3 play %s", g_station_url[idx] );

	if( announce )
		client_print( id, print_chat, "[H9] Radio: %s. Say /radio off to stop.", g_station_name[idx] );
}

tune_url( id, const url[] )
{
	g_source[id] = SRC_RADIO;
	g_tuned[id]  = -1;
	copy( g_custom[id], charsmax( g_custom[] ), url );

	set_volume( id );
	client_cmd( id, "mp3 play %s", url );
	client_print( id, print_chat, "[H9] Radio: %s", url );
}

radio_off( id )
{
	client_cmd( id, "mp3 stop" );

	// Falling silent is rarely what someone wants: hand the channel back to the ambience
	// the server was playing, unless the server has the rotation switched off.
	if( get_pcvar_num( cvar_ambient ) && g_music_cur != -1 )
	{
		start_ambient_for( id );
		client_print( id, print_chat, "[H9] Radio off, ambient music back on." );
	}
	else
	{
		g_source[id] = SRC_OFF;
		client_print( id, print_chat, "[H9] Radio off." );
	}
}

// ---------------------------------------------------------------- ambient rotation

start_ambient_for( id )
{
	if( !is_user_connected( id ) || is_user_bot( id ))
		return;

	if( g_music_cur < 0 || g_music_cur >= sizeof g_music_mp3 )
		return;

	g_source[id] = SRC_AMBIENT;

	// contaminated.wav and vangelis.wav are not mp3s: they go through playvol, as in
	// ts_matchmode. The mp3 player only handles the mp3 tracks.
	if( music_is_wav( g_music_cur ))
		client_cmd( id, "playvol music/%s %f", g_music_mp3[g_music_cur], get_pcvar_float( cvar_volume ));
	else
	{
		set_volume( id );
		client_cmd( id, "mp3 play sound/music/%s", g_music_mp3[g_music_cur] );
	}
}

bool:music_is_wav( idx )
{
	new len = strlen( g_music_mp3[idx] );

	return ( len > 4 && equali( g_music_mp3[idx][len - 4], ".wav" ));
}

/// Pick the next track from the bag, play it to everyone on ambient, and schedule the one
/// after it. Players on the radio are skipped: their channel is theirs.
/// ts_matchmode's answer to "does this map want ambient music". Without ts_matchmode there is no
/// rule to follow, and the rotation plays whenever this plugin is on.
tsm_music_wanted()
{
	if( callfunc_begin( "music_wanted_here", "ts_matchmode.amxx" ) != 1 )
		return 1;
	return callfunc_end();
}

public task_ambient()
{
	if( !get_pcvar_num( cvar_enabled ) || !get_pcvar_num( cvar_ambient ))
		return;

	// The map's own rule for ambient music, from ts_matchmode: the match mode on, or a roleplay
	// map with tsm_music_rp. Asked again every 10 seconds, so the music starts once it is wanted.
	if( !tsm_music_wanted())
	{
		set_task( 10.0, "task_ambient", TASK_AMBIENT );
		return;
	}

	new idx = pick_track();

	if( idx == -1 )
		return;

	g_music_cur = idx;
	g_music_played[idx] = true;

	new players[RADIO_SLOTS], num;
	get_players( players, num, "ch" );   // connected, not bots

	for( new i = 0; i < num && i < g_maxplayers; i++ )
	{
		if( g_source[players[i]] == SRC_RADIO )
			continue;                     // leave the radio alone

		start_ambient_for( players[i] );
	}

	log_amx( "[H9RADIO] Ambient: %s", g_music_mp3[idx] );

	set_task( g_music_len[idx] + 2.0, "task_ambient", TASK_AMBIENT );
}

/// A track from the bag that has not played in this pass. When the bag empties it refills,
/// avoiding an immediate repeat of the track that just finished.
pick_track()
{
	new pool[sizeof g_music_mp3], n = 0;

	for( new i = 0; i < sizeof g_music_mp3; i++ )
	{
		if( !g_music_played[i] )
			pool[n++] = i;
	}

	if( n == 0 )
	{
		for( new i = 0; i < sizeof g_music_mp3; i++ )
			g_music_played[i] = false;

		for( new i = 0; i < sizeof g_music_mp3; i++ )
		{
			if( i != g_music_cur )
				pool[n++] = i;
		}
	}

	if( n == 0 )
		return -1;

	return pool[random( n )];
}
