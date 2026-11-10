/*
 * ts_floatchat -- what a player said, shown above their head.
 *
 * Two different things, drawn two different ways, because the engine gives exactly one
 * tool for each and they are not the same tool.
 *
 *   THE BUBBLE is a SPRITE above the head. It marks a place in the world, which is what a
 *   sprite is for and what the class icons in ts_matchmode already do.
 *
 *   THE WORDS reach a player one of two ways, by what his game says it can draw.
 *
 *     A CLIENT THAT DRAWS THEM ITSELF (H9's reTS client; its userinfo key _h9chatbubble is 1) is sent
 *     each line once, as the H9Say user message: the words, how long they stay and how far they show.
 *     Its own client keeps each speaker's latest line and draws it in a box over the head of the
 *     speaker its crosshair is on, placed on its own screen every frame -- so the words never lag a
 *     turn, take no HUD channel and cannot run into another speaker's. reTS cl_dll\h9_chatbubble.cpp
 *     is that half; docs\CHAT_BUBBLES.txt the protocol and the guide.
 *
 *     EVERY OTHER CLIENT is sent a HUDMESSAGE. Text cannot be a sprite -- it is arbitrary words at
 *     runtime -- so it goes through the only screen-space tool that takes a position, and the head is
 *     projected into each viewer's screen to place it.
 *
 * WHY NOT BOTH AS SPRITES, since a sprite follows the head for free: a sprite is a picture
 * chosen before the map loads. There is no way to put words into one at runtime.
 *
 * WHY NOT BOTH AS HUDMESSAGES: a hudmessage is placed in SCREEN space, so it has to be
 * re-projected for every viewer every tick, and it lags a fast turn. For a mark that
 * belongs at a fixed place in the world, a sprite is simply correct and the projection is
 * a workaround only text needs.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT CANNOT BE DONE, said plainly because it is the obvious first request.
 *
 * THE SERVER CANNOT SEE WHAT ANYONE IS TYPING. GoldSrc has no keystroke stream; a message
 * exists only when enter is pressed. Nor does a stock engine tell the server the chat box
 * opened: messagemode and messagemode2 are the engine's own commands on the client, run there
 * and never sent on, on GoldSrc and Xash alike -- so a hook on them never fires, and that is
 * why no bubble ever showed. The H9XASH engine says it instead (engine-h9-typing.patch): the
 * client command "h9_typing 1" as the chat line opens and "h9_typing 0" as it closes, sent or
 * not, every time -- to a server that registered the H9Typing user message, as this plugin
 * does. So on H9XASH the bubble is live -- it means "this person is typing" -- and the words
 * appear when they send. A Steam client says nothing, and shows no bubble. (An H9XASH engine
 * from before the command set the userinfo key _h9typing instead, which is still read.)
 * ---------------------------------------------------------------------------------------
 */
#include <amxmodx>
#include <fakemeta>
#include <tsm_api>

#define PLUGIN  "TS Float Chat"
#define VERSION "1.0"
#define AUTHOR  "TSM"

#define MAXPL (MAX_PLAYERS + 1)

/*
 * The sprite, and the frames it animates through.
 *
 * Four: the lit dot walking across the three, then a blank beat. The engine is told which
 * to draw through pev_frame, exactly as ts_matchmode drives the class sheet, so nothing
 * new is needed to run it.
 */
#define FC_SPR    "sprites/tsm_typing.spr"
#define FC_FRAMES 4

// From the HL SDK.
#define FC_EF_NODRAW       128
#define FC_MOVETYPE_NOCLIP 8
#define FC_SOLID_NOT       0

/*
 * THE HUD CHANNELS, and why there are only three.
 *
 * set_hudmessage's last argument is the channel, and a message replaces whatever was on
 * the channel it is sent to. ts_matchmode already uses 1, 2, 3, 4 and 5 -- the countdown,
 * the round clock, the spectator lines -- so writing to any of those would stamp over the
 * round banner mid-countdown.
 *
 * That leaves 0, 6 and 7. Three people's words on screen at once, per viewer; a fourth
 * talker takes the oldest slot rather than stealing a channel that is not ours. It is a
 * limit of the engine, not a decision. (A client that draws the words itself has no such limit.)
 */
new const FC_CHANNELS[] = { 0, 6, 7 };
#define FC_SLOTS 3

new g_slot_owner[FC_SLOTS];        // which player is in each slot, 0 for free
new Float:g_slot_until[FC_SLOTS];  // when their words come down
new g_slot_text[FC_SLOTS][128];
new g_slot_lines[FC_SLOTS];        // the words' lines, 1 or 2
new g_slot_width[FC_SLOTS];        // the longer line's length, in characters
new Float:g_slot_top[FC_SLOTS][2]; // the talker's head above his origin, standing and ducking (head_tops)
new Trie:g_tops_cache;             // model name -> the two numbers read from the model file; 0 0 for one that cannot be read

new bool:g_spr_ok;
new g_bubble[MAXPL];               // the typing sprite, one per player, kept
new bool:g_typing[MAXPL];          // the chat line is open: h9_typing 1 (or an old _h9typing "1")

/*
 * A BUBBLE NEVER HANGS. The engine says h9_typing 1 again every 2 seconds while the line stays
 * open, so a bubble with no word for FC_TYPING_QUIET seconds comes down by itself (a close that
 * never arrived); FC_TYPING_QUIET_OLD for an earlier engine's _h9typing, which says nothing
 * between. It comes down too when the player dies, changes team or leaves.
 */
#define FC_TYPING_QUIET     5.0
#define FC_TYPING_QUIET_OLD 30.0
new Float:g_typing_at[MAXPL];      // the last word that the line is open
new bool:g_typing_cmd[MAXPL];      // that word came as h9_typing, which is said again while open
new g_typing_team[MAXPL];          // the team he was on as the line opened
new bool:g_typing_logged;          // the first _h9typing on this map has been logged

/*
 * FLOAT CHAT OFF, per player. A player who has it off is sent neither: no typing bubble (held back
 * from him in fw_addtofullpack_pre) and no words over heads (draw_for skips him), so he costs
 * nothing. .bubbles toggles it and is remembered in FC_OFF_FILE, by the player's h9_clientid or
 * authid; the userinfo key _h9bubbles, when he has one, wins (setinfo _h9bubbles 0 in his
 * userconfig.cfg keeps it off on every server).
 */
#define FC_OFF_FILE "ts_floatchat_off.txt"
new bool:g_off[MAXPL];             // float chat off for this player
new bool:g_off_stored[MAXPL];      // FC_OFF_FILE has him off, read as he joins
new bool:g_is_bubble[2048];        // edict -> a typing bubble, for fw_addtofullpack_pre
new g_fw_afp = -1;                 // the AddToFullPack pre hook: only while someone has it off

/*
 * THE WORDS, FOR A CLIENT THAT DRAWS THEM (the H9Say message). Sent once, when the line is said, to every
 * living human whose userinfo _h9chatbubble starts with 1 and who has float chat on -- for a say_team line, only to
 * the speaker's own team unless h9_floatchat_bubble_team is 0; the speaker too only when wants_own says so (YOUR
 * OWN LINE). Unreliable, as h9_tts's H9Tts is: a line lost to a bad packet is a line not shown, and a burst of
 * chat never fills a reliable channel.
 *
 *   byte    the speaker's slot
 *   byte    flags: bit 0 (FC_MSG_F_TEAM) says it was a team line
 *   short   how long the line stays, in tenths of a second; 0 takes the speaker's line down
 *   short   how far away it shows, in units (fc_range)
 *   byte    the top of the speaker's head above his origin standing, in units (head_tops)
 *   byte    the same ducking
 *   string  the words: h9_floatchat_bubble_maxchars at most, never broken into lines
 *
 * A slot of 0 with a ttl of 0 takes every line down, for the one viewer it is sent to. A line comes down
 * for everyone before its time when its speaker dies, leaves the match or the server, or stops being shown
 * (may_talk); task_float watches for it.
 *
 * THE USERINFO KEY _h9chatbubble is how a game says what it does, in the key's value:
 *
 *   0, nothing, or anything that does not start with 1   it cannot draw the words: it is sent the hudmessage
 *   1                                                    it draws them (H9Say); no line of its own
 *   1s                                                   it draws them and asks for its own line too
 *
 * The first character is all an older ts_floatchat tests (== '1'), so it reads "1s" as "1": a game that asks for
 * its own line is still drawn for, and an older client's "1" means what it always did. A userinfo is 256 bytes
 * and full, so the own line has no key of its own: the s is one byte more, sent only by a player who turned his
 * own line on.
 */
#define FC_MSG_F_TEAM        1
#define FC_BUBBLE_RAW        152    // the most bytes of words sent in one H9Say
#define FC_BUBBLE_MAXCHARS_MAX 150
#define FC_BUBBLE_HOLD_MAX   30.0
#define FC_INFO_DRAWS        '1'    // _h9chatbubble's first character: the game draws the words itself
#define FC_INFO_SELF         's'    // its second: and the player wants his own line
new g_msg_say;                     // the H9Say user message
new bool:g_bubble_cli[MAXPL];      // his game draws the words itself: _h9chatbubble starts with 1
new bool:g_bubble_self[MAXPL];     // and he asked for his own line: _h9chatbubble is 1s
new Float:g_say_until[MAXPL];      // when the line last sent to the clients that draw them runs out, for each speaker; 0 for none

/*
 * WHERE IT SITS. The bubble is fc_rise units above the player's eyes (origin plus view_ofs), so it
 * follows him down when he ducks, goes prone or dives, as his eyes do. The words rest FC_HEAD_GAP units
 * above the top of his head, their box centred on that point and resting on it; while his typing bubble
 * is drawn they rest FC_HEAD_GAP units over the top of that instead (words_anchor), so a line still up when
 * he opens the chat line again never sits on the bubble; and cmd_say takes the bubble down the moment a line
 * is sent, so new words never arrive under one. The client that draws the words itself lifts its box over the
 * bubble the same way (reTS cl_dll\h9_chatbubble.cpp).
 *
 * THE BUBBLE'S TOP is its centre plus half the sprite's height: the frames of FC_SPR are 128 x 96 pixels,
 * centred on the entity's origin, a pixel is a unit at scale 1 and the entity is drawn at fc_scale (0.20), so
 * it is 19.2 units tall and its top is 9.6 over its centre. FC_SPR_HALF_H is the 48 pixels; a sprite of
 * another size needs it changed here and in the client (TYPING_HALF_H).
 *
 * THE TOP OF THE HEAD is read from the player's model, not guessed from the hull. A model is drawn in its
 * own coordinates around the player's origin, and the bounding box of its idle sequences (in the model's
 * own file, models/player/<name>/<name>.mdl) says how far up it reaches: 35 to 39 for a human model, 48 for
 * the Mech and the ED-209, standing, and 23 to 26 for a human ducking. head_tops reads those two numbers once for
 * each model name (the userinfo key "model") and keeps them; a model it cannot read is taken to be 36 and
 * 22. The player's own scale (pev_scale, set by whatever draws him larger or smaller) stretches them, and
 * the flag FL_DUCKING picks between the two.
 *
 * YOUR OWN LINE. His own bubble, over his own head, is out of his first-person view, and so are his own
 * words, so they are sent to him only when he wants them: a player's own line goes to him when his game
 * asked for it (_h9chatbubble is 1s, from cl_h9_chatbubble_own 1) or fc_self is 1 (wants_own). It is
 * centred near the top of his screen (FC_SELF_Y), where the client's own box also puts it; in third person
 * he sees his bubble over his head as anyone does. fc_self 1 is the server's say for everyone, whatever
 * his game asks. A game that cannot draw the words has no way to ask, so for a player on one (a Steam
 * client, or cl_h9_chatbubble 0) fc_self 1 is the only way to his own line, as a hudmessage.
 */
#define FC_HEAD_GAP    6.0
#define FC_SPR_HALF_H  48.0
// The head's top above the origin when the model cannot be read: a human model's, standing and ducking.
#define FC_HEAD_STAND  36.0
#define FC_HEAD_DUCK   22.0
#define FC_SELF_Y      0.30
// The words' box, as a share of the screen: a character's width and the line's height.
#define FC_CHAR_W      0.0065
#define FC_LINE_H      0.03

/*
 * THE WORDS THEMSELVES are what the player said and nothing added: fc_tidy takes out control characters
 * and doubled spaces, sets a line typed in capitals in sentence case, cuts it to h9_floatchat_maxchars
 * (FC_MAXCHARS_MIN to FC_MAXCHARS_MAX; "..." marks the cut, at a space when one is in the last
 * FC_CUT_BACK characters) and breaks it into two lines at most, at a space, each line within
 * FC_LINE_SLACK of half the limit. A line stays up fc_hold seconds and
 * FC_HOLD_PER_CHAR more for each character, so a longer one is read before it goes.
 */
#define FC_RAW_LEN       192
#define FC_MAXCHARS_MIN  12
#define FC_MAXCHARS_MAX  100
#define FC_CUT_BACK      12
#define FC_LINE_SLACK    8
#define FC_HOLD_PER_CHAR 0.04

// The words as last sent to each viewer, so a line that has not moved on his screen is not sent
// again until the one before is about to run out.
new Float:g_sent_x[MAXPL][FC_SLOTS];
new Float:g_sent_y[MAXPL][FC_SLOTS];
new Float:g_sent_at[MAXPL][FC_SLOTS];

new g_cv_on, g_cv_range, g_cv_hold, g_cv_rise, g_cv_scale, g_cv_maxchars;
new g_cv_r, g_cv_g, g_cv_b, g_cv_ytweak, g_cv_self;
new g_cv_words, g_cv_hud, g_cv_typing;
new g_cv_bubble, g_cv_bubble_hold, g_cv_bubble_maxchars, g_cv_bubble_team;
new g_cv_tsm;                     // ts_matchmode's tsm_enabled; 0 without it
new bool:g_have_core = true;     // ts_matchmode's natives are bound (native_filter)

public plugin_natives()
{
	set_native_filter("native_filter");
}

/// A missing tsm_* native is allowed: without ts_matchmode every live player can talk.
public native_filter(const name[], index, trap)
{
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "tsm_", 4))
	{
		g_have_core = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public plugin_cfg()
{
	g_cv_tsm = get_cvar_pointer("tsm_enabled");
}

/// Who gets a bubble and words: a live player, and while the match mode runs on this map only one
/// it draws as he is (ts_matchmode's tsm_shown): in the match, the round frozen, live or just
/// ended, and not cloaked -- never anyone eliminated, spectating, in warmup or ready-up, at a
/// match's end, or under the Recon's .cloak. task_float asks again every tick, so a bubble or a
/// line already up comes down the moment its player stops being shown.
bool:may_talk(id)
{
	if (!is_user_alive(id))
	{
		return false;
	}
	if (g_have_core && g_cv_tsm && get_pcvar_num(g_cv_tsm))
	{
		return tsm_shown(id) != 0;
	}
	return true;
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	// The chat line opening and closing: the H9XASH engine's h9_typing command, and the
	// userinfo key _h9typing an earlier H9XASH engine set (plus _h9bubbles, below).
	register_clcmd("h9_typing", "cmd_h9_typing");
	register_forward(FM_ClientUserInfoChanged, "fw_userinfo_post", 1);

	register_clcmd("say",      "cmd_say");
	register_clcmd("say_team", "cmd_say");

	// Xash3D FWGS: AMXX finds no SV_DropClient there, so client_disconnected never fires for a
	// player leaving; Metamod's ClientDisconnect does, on any engine. ts_matchmode does the same.
	if (cvar_exists("host_ver"))
	{
		register_forward(FM_ClientDisconnect, "fw_client_disconnect_xash");
	}

	g_cv_on     = register_cvar("fc_enabled",  "1");
	g_cv_range  = register_cvar("fc_range",    "900");
	g_cv_hold   = register_cvar("fc_hold",     "5.0");
	g_cv_rise   = register_cvar("fc_rise",     "24.0");   // above the eyes (WHERE IT SITS)
	g_cv_scale  = register_cvar("fc_scale",    "0.20");

	// The most characters of a line shown over a head; a longer one is cut with "..." (THE WORDS THEMSELVES)
	g_cv_maxchars = register_cvar("h9_floatchat_maxchars", "48");
	g_tops_cache = TrieCreate();

	g_cv_r = register_cvar("fc_red",   "150");
	g_cv_g = register_cvar("fc_green", "215");
	g_cv_b = register_cvar("fc_blue",  "255");

	/*
	 * The server does not know the viewer's aspect ratio, and the vertical half-angle
	 * depends on it. The maths below assumes 4:3; this nudges the result for anyone on
	 * something else, rather than pretending it can be worked out.
	 */
	g_cv_ytweak = register_cvar("fc_y_tweak", "1.0");

	// 1: every player is sent his own words as well, whatever his game asks; 0: only a player whose game asks for them
	// is (YOUR OWN LINE, above). 0 by default.
	g_cv_self = register_cvar("fc_self", "0");

	// What is shown, one switch each (fc_enabled is the master of all of it).
	g_cv_words  = register_cvar("h9_floatchat_words",  "1");   // 0: no words over heads for any client
	g_cv_hud    = register_cvar("h9_floatchat_hud",    "1");   // 0: a client that cannot draw the words itself is sent none
	g_cv_typing = register_cvar("h9_floatchat_typing", "1");   // 0: the typing bubble sprite is never shown

	// For a client that draws the words itself (THE WORDS, FOR A CLIENT THAT DRAWS THEM)
	g_cv_bubble          = register_cvar("h9_floatchat_bubble",          "1");   // 0: every client is sent the hudmessage
	g_cv_bubble_hold     = register_cvar("h9_floatchat_bubble_hold",     "0");   // seconds a line stays; 0: fc_hold and a little more for a longer line
	g_cv_bubble_maxchars = register_cvar("h9_floatchat_bubble_maxchars", "96");  // the most characters of a line (12 to 150)
	g_cv_bubble_team     = register_cvar("h9_floatchat_bubble_team",     "1");   // 1: a say_team line goes to the speaker's team only

	// Ten times a second. Fast enough to follow someone running, far short of the cost of
	// doing it every frame for every pair of players.
	set_task(0.1, "task_float", 4211, "", 0, "b");
}

public plugin_precache()
{
	// A precache of a path that is not there is a fatal Host_Error that closes the server,
	// so this is checked rather than assumed -- the same guard ts_matchmode uses.
	if (file_exists(FC_SPR))
	{
		precache_model(FC_SPR);
		g_spr_ok = true;
	}
	else
	{
		log_amx("[FC] %s is missing -- typing bubbles are off for this map.", FC_SPR);
	}

	// Never sent. Registered so the H9XASH engine knows this server takes h9_typing: it sends
	// the command only to a server whose game has this message.
	engfunc(EngFunc_RegUserMsg, "H9Typing", 0);

	// The words for a client that draws them itself: variable length, registered whatever the cvars say,
	// so that every game learns the message at connect (as h9_tts does for H9Tts).
	g_msg_say = engfunc(EngFunc_RegUserMsg, "H9Say", -1);
}

public client_putinserver(id)
{
	g_typing[id] = false;
	g_bubble[id] = 0;
	g_say_until[id] = 0.0;
	g_bubble_cli[id] = false;
	g_bubble_self[id] = false;
	for (new s = 0; s < FC_SLOTS; s++)
	{
		g_sent_at[id][s] = -1.0;
	}
	g_off_stored[id] = false;
	new key[64];
	if (!is_user_bot(id) && player_key(id, key, charsmax(key)))
	{
		g_off_stored[id] = stored_off(key);
	}
	refresh_off(id);
	refresh_bubble_client(id);
}

public client_disconnected(id)
{
	player_left(id);
}

/// Xash3D: a player leaving, from Metamod's ClientDisconnect. Registered only on Xash.
public fw_client_disconnect_xash(id)
{
	if (id >= 1 && id < MAXPL)
	{
		player_left(id);
	}
	return FMRES_IGNORED;
}

player_left(id)
{
	drop_bubble(id);
	g_bubble_cli[id] = false;
	g_bubble_self[id] = false;
	if (g_say_until[id] > 0.0)
	{
		g_say_until[id] = 0.0;
		send_bubble_clear(id);
	}
	for (new i = 0; i < FC_SLOTS; i++)
	{
		if (g_slot_owner[i] == id)
		{
			g_slot_owner[i] = 0;
			g_slot_until[i] = 0.0;
		}
	}
	g_off[id] = false;
	g_off_stored[id] = false;
	update_afp_hook(id);
}

/* ---- float chat off, per player ------------------------------------------ */

/// The key a player's choice is kept by: his h9_clientid (H9XASH), else an authid that is his
/// alone. False when he has neither.
bool:player_key(id, key[], len)
{
	get_user_info(id, "h9_clientid", key, len);
	// the id is 32 lowercase hex characters or nothing: a client chooses the text, and it goes into a data file
	new bool:hex = (strlen(key) == 32);
	for (new i = 0; hex && key[i]; i++)
	{
		hex = ('0' <= key[i] <= '9') || ('a' <= key[i] <= 'f');
	}
	if (hex)
	{
		return true;
	}
	key[0] = 0;
	get_user_authid(id, key, len);
	return key[0] && !equali(key, "STEAM_ID_LAN") && !equali(key, "STEAM_ID_PENDING")
		&& !equali(key, "VALVE_ID_LAN") && !equali(key, "VALVE_ID_PENDING") && !equali(key, "BOT")
		&& !equali(key, "HLTV") && !equali(key, "UNKNOWN");
}

stored_path(path[], len)
{
	get_localinfo("amxx_datadir", path, len);
	format(path, len, "%s/%s", path, FC_OFF_FILE);
}

/// Is this key in FC_OFF_FILE, a player who turned float chat off?
bool:stored_off(const key[])
{
	new path[128];
	stored_path(path, charsmax(path));
	new f = fopen(path, "rt");
	if (!f)
	{
		return false;
	}
	new line[96], bool:found = false;
	while (!found && !feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		found = line[0] && line[0] != '/' && equal(line, key);
	}
	fclose(f);
	return found;
}

/// Puts this key in FC_OFF_FILE (off) or takes it out (on). The file holds only the players who
/// turned float chat off, one key a line.
store_off(const key[], bool:off)
{
	new path[128], tmp[136];
	stored_path(path, charsmax(path));
	formatex(tmp, charsmax(tmp), "%s.new", path);
	new out = fopen(tmp, "wt");
	if (!out)
	{
		return;
	}
	fputs(out, "// Players who turned ts_floatchat off with .bubbles, by h9_clientid or authid. One a line.^n");
	new f = fopen(path, "rt");
	if (f)
	{
		new line[96];
		while (!feof(f))
		{
			fgets(f, line, charsmax(line));
			trim(line);
			if (line[0] && line[0] != '/' && !equal(line, key))
			{
				fprintf(out, "%s^n", line);
			}
		}
		fclose(f);
	}
	if (off)
	{
		fprintf(out, "%s^n", key);
	}
	fclose(out);
	delete_file(path);
	rename_file(tmp, path, 1);
}

/// Works out whether a player has float chat off: his userinfo _h9bubbles when he has one, else
/// his choice in FC_OFF_FILE.
refresh_off(id)
{
	new ui[4];
	get_user_info(id, "_h9bubbles", ui, charsmax(ui));
	new bool:off = ui[0] ? (ui[0] == '0') : g_off_stored[id];
	if (off != g_off[id])
	{
		g_off[id] = off;
		update_afp_hook(0);
	}
}

/// What this player's game says it does (THE USERINFO KEY _h9chatbubble): whether it draws the words itself, his
/// userinfo _h9chatbubble starting with 1 (H9's client says so while cl_h9_chatbubble is not 0), and whether he
/// also wants his own line, the character after it being s (cl_h9_chatbubble_own 1). The value is read to 3
/// characters and only its first two matter; anything else, an empty value too, is a game that draws nothing.
refresh_bubble_client(id)
{
	new ui[4];
	get_user_info(id, "_h9chatbubble", ui, charsmax(ui));
	g_bubble_cli[id] = (ui[0] == FC_INFO_DRAWS);
	g_bubble_self[id] = (g_bubble_cli[id] && ui[1] == FC_INFO_SELF);
}

/// Whether this player is sent his own line: fc_self 1 for everyone, else only one whose game asked for it.
bool:wants_own(id)
{
	return get_pcvar_num(g_cv_self) != 0 || g_bubble_self[id];
}

/// The AddToFullPack hook runs for every entity and every player each frame, so it is there only
/// while a player who has float chat off is on the server. `leaving` is a player on his way out.
update_afp_hook(leaving)
{
	new bool:need = false;
	for (new i = 1; i < MAXPL; i++)
	{
		if (i != leaving && g_off[i] && is_user_connected(i))
		{
			need = true;
			break;
		}
	}
	if (need && g_fw_afp == -1)
	{
		g_fw_afp = register_forward(FM_AddToFullPack, "fw_addtofullpack_pre");
	}
	else if (!need && g_fw_afp != -1)
	{
		unregister_forward(FM_AddToFullPack, g_fw_afp);
		g_fw_afp = -1;
	}
}

/// Where a player's bubble sits: fc_rise units above his eyes, as they are now.
bubble_anchor(id, Float:at[3])
{
	new Float:ofs[3];
	pev(id, pev_origin, at);
	pev(id, pev_view_ofs, ofs);
	at[0] += ofs[0];
	at[1] += ofs[1];
	at[2] += ofs[2] + get_pcvar_float(g_cv_rise);
}

/// The top of a player's head above his origin, standing and ducking, from his model (THE TOP OF THE
/// HEAD); a model that cannot be read leaves the human numbers.
head_tops(id, Float:tops[2])
{
	tops[0] = FC_HEAD_STAND;
	tops[1] = FC_HEAD_DUCK;

	new model[40];
	get_user_info(id, "model", model, charsmax(model));
	if (model[0])
	{
		model_tops(model, tops);
	}
}

/// A model's two numbers into tops, from the cache or else from the model file; tops is left as it was
/// for a name that is not a model's folder name or a file that cannot be read.
model_tops(const model[], Float:tops[2])
{
	// the name goes into a file path: letters, digits, _ and - only
	new key[40];
	new n = 0;
	for (new i = 0; model[i] && n < charsmax(key); i++)
	{
		new c = model[i];
		if (c >= 'A' && c <= 'Z')
		{
			c += 32;
		}
		else if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-'))
		{
			return;
		}
		key[n++] = c;
	}
	key[n] = 0;

	new Float:got[2];
	if (!TrieGetArray(g_tops_cache, key, got, 2))
	{
		got[0] = 0.0;
		got[1] = 0.0;
		read_model_tops(model, got);
		TrieSetArray(g_tops_cache, key, got, 2);
	}
	if (got[0] > 0.0)
	{
		tops[0] = got[0];
		tops[1] = got[1];
	}
}

/*
 * Reads a studio model's header and its sequences' bounding boxes: the top of the box of the first
 * "standard_idle" sequence is the standing number and that of the first "duck_idle" one the ducking
 * number. The file's own layout (studiohdr_t): "IDST" at 0, the sequence count and the offset of the
 * sequences at 164 and 168; a sequence is 176 bytes, its name the first 32, its bounding box's top at
 * 116. Numbers that are not a plausible height leave the pair at 0 0.
 */
read_model_tops(const model[], Float:tops[2])
{
	new path[96];
	formatex(path, charsmax(path), "models/player/%s/%s.mdl", model, model);
	if (!file_exists(path))
	{
		return;
	}
	new f = fopen(path, "rb");
	if (!f)
	{
		return;
	}

	new magic, numseq, seqindex;
	fread(f, magic, BLOCK_INT);
	if (magic == 0x54534449)
	{
		fseek(f, 164, SEEK_SET);
		fread(f, numseq, BLOCK_INT);
		fread(f, seqindex, BLOCK_INT);
		if (numseq > 0 && numseq <= 1024 && seqindex > 0)
		{
			new Float:stand = 0.0, Float:duck = 0.0;
			for (new i = 0; i < numseq && i < 160 && (stand <= 0.0 || duck <= 0.0); i++)
			{
				new base = seqindex + i * 176;
				new label[16];
				fseek(f, base, SEEK_SET);
				for (new k = 0; k < 13; k++)
				{
					new ch;
					fread(f, ch, BLOCK_BYTE);
					label[k] = ch;
				}
				label[13] = 0;

				new bool:is_stand = (stand <= 0.0 && equal(label, "standard_idle", 13));
				new bool:is_duck = (duck <= 0.0 && equal(label, "duck_idle", 9));
				if (is_stand || is_duck)
				{
					new bits;
					fseek(f, base + 116, SEEK_SET);
					fread(f, bits, BLOCK_INT);
					new Float:top = Float:bits;
					if (top >= 8.0 && top <= 200.0)
					{
						if (is_stand)
						{
							stand = top;
						}
						else
						{
							duck = top;
						}
					}
				}
			}
			if (stand > 0.0)
			{
				tops[0] = stand;
				tops[1] = (duck > 0.0) ? duck : (stand - 14.0);
			}
		}
	}
	fclose(f);
}

/// How high a talker's head reaches above his origin now: his model's top for the way he stands, at his scale.
Float:head_top_now(id, slot)
{
	new Float:scale;
	pev(id, pev_scale, scale);
	if (scale < 0.1)
	{
		scale = 1.0;   // 0 and 1 both draw him at his own size
	}
	return g_slot_top[slot][(pev(id, pev_flags) & FL_DUCKING) ? 1 : 0] * scale;
}

/// Whether this player's typing bubble is drawn now: its sprite is there and not hidden. place_bubble shows or
/// hides it every tick, ahead of the words, and cmd_say hides it the moment the line is sent.
bool:bubble_up(id)
{
	new ent = g_bubble[id];
	return ent > 0 && pev_valid(ent) && !(pev(ent, pev_effects) & FC_EF_NODRAW);
}

/// The top of a player's typing bubble: its centre (bubble_anchor) plus half the sprite's height at the scale it
/// is drawn at (THE BUBBLE'S TOP). A scale of 0 draws the sprite at its own size, as it does a model.
Float:bubble_top(id)
{
	new Float:at[3];
	bubble_anchor(id, at);
	new Float:scale = get_pcvar_float(g_cv_scale);
	if (scale <= 0.0)
	{
		scale = 1.0;
	}
	return at[2] + FC_SPR_HALF_H * scale;
}

/// Where a talker's words rest: just above the top of his head, or just above the top of his typing bubble while
/// that is drawn, whichever is higher.
words_anchor(id, slot, Float:at[3])
{
	pev(id, pev_origin, at);
	at[2] += head_top_now(id, slot) + FC_HEAD_GAP;
	if (bubble_up(id))
	{
		new Float:over = bubble_top(id) + FC_HEAD_GAP;
		if (over > at[2])
		{
			at[2] = over;
		}
	}
}

/// A typing bubble is never sent to a player who has float chat off.
public fw_addtofullpack_pre(es, e, ent, host, hostflags, player, pSet)
{
	if (ent > 0 && ent < sizeof g_is_bubble && g_is_bubble[ent] && host > 0 && host < MAXPL && g_off[host])
	{
		forward_return(FMV_CELL, 0);
		return FMRES_SUPERCEDE;
	}
	return FMRES_IGNORED;
}

/// .bubbles: float chat off for this player, or back on. Kept in FC_OFF_FILE and in his userinfo.
cmd_bubbles(id)
{
	new bool:off = !g_off[id];
	new key[64];
	if (player_key(id, key, charsmax(key)))
	{
		store_off(key, off);
	}
	g_off_stored[id] = off;

	// In his userinfo too, as tsm_music keeps its choice. A client may refuse a server's
	// setinfo; the file above holds the choice then.
	new ui[4];
	get_user_info(id, "_h9bubbles", ui, charsmax(ui));
	client_cmd(id, "setinfo _h9bubbles %d", off ? 0 : 1);
	g_off[id] = off;
	update_afp_hook(0);

	if (off)
	{
		bubble_clear_msg(id, 0);
		client_print(id, print_chat, "[FC] Float chat is OFF for you: no typing bubbles, no words over heads. Type .bubbles to turn it back on.");
	}
	else
	{
		client_print(id, print_chat, "[FC] Float chat is ON for you: typing bubbles and words over heads. Type .bubbles to turn it off.");
	}
	if (ui[0] && (ui[0] == '0') != off)
	{
		client_print(id, print_chat, "[FC] If your own setinfo _h9bubbles %s is still set, it decides: change it in your console.", ui);
	}
}

/* ---- the bubble ---------------------------------------------------------- */

/*
 * One sprite per player, made once and kept.
 *
 * Not made and destroyed as people type: entity churn is what exhausted the edict table in
 * this mod before and stopped weapons spawning at all. It is hidden when it should not be
 * seen instead, which is how ts_matchmode's class icons are handled for the same reason.
 */
bubble_entity(id)
{
	if (!g_spr_ok)
	{
		return 0;
	}
	if (g_bubble[id] > 0 && pev_valid(g_bubble[id]))
	{
		return g_bubble[id];
	}

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (!ent)
	{
		g_bubble[id] = 0;
		log_amx("[FC] could not create a typing bubble for %d -- out of edicts?", id);
		return 0;
	}

	engfunc(EngFunc_SetModel, ent, FC_SPR);
	if (ent < sizeof g_is_bubble)
	{
		g_is_bubble[ent] = true;
	}
	set_pev(ent, pev_classname, "ts_floatchat_bubble");
	set_pev(ent, pev_owner, id);
	set_pev(ent, pev_movetype, FC_MOVETYPE_NOCLIP);
	set_pev(ent, pev_solid,    FC_SOLID_NOT);
	set_pev(ent, pev_rendermode, 4);     // kRenderTransAlpha: the sprite's own alpha test
	set_pev(ent, pev_renderamt,  255.0);
	set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);

	g_bubble[id] = ent;
	return ent;
}

/// The bubble out of sight, kept for the next time (place_bubble hides it on the next tick anyway when the
/// chat line closed some other way).
hide_bubble(id)
{
	if (id < 1 || id >= MAXPL)
	{
		return;
	}
	new ent = g_bubble[id];
	if (ent > 0 && pev_valid(ent))
	{
		set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);
	}
}

drop_bubble(id)
{
	g_typing[id] = false;
	new ent = g_bubble[id];
	if (ent > 0 && ent < sizeof g_is_bubble)
	{
		g_is_bubble[ent] = false;
	}
	if (ent > 0 && pev_valid(ent))
	{
		engfunc(EngFunc_RemoveEntity, ent);
	}
	g_bubble[id] = 0;
}

/* ---- the two things a player does ---------------------------------------- */

/*
 * The chat line opened or closed: _h9typing in the userinfo, "1" while it is open and "0" once
 * it closes, sent or not -- set by the H9XASH engine (engine-h9-typing.patch) and by nothing else.
 */
public fw_userinfo_post(id, buffer)
{
	if (id < 1 || id >= MAXPL || !is_user_connected(id) || is_user_bot(id))
	{
		return FMRES_IGNORED;
	}

	// _h9bubbles may have changed with it: float chat off for him, or back on; and _h9chatbubble, whether his
	// game draws the words itself.
	refresh_off(id);
	refresh_bubble_client(id);

	// An earlier H9XASH engine's _h9typing, read only when the key is there at all: today's
	// engine sends h9_typing instead and leaves the key out.
	new v[4];
	v[0] = 0;
	engfunc(EngFunc_InfoKeyValue, buffer, "_h9typing", v, charsmax(v));
	if (v[0])
	{
		set_typing(id, v[0] == '1', "_h9typing");
	}
	return FMRES_IGNORED;
}

/// h9_typing 1 / 0, from the H9XASH engine as the chat line opens and closes. Kept from TS, which
/// would answer it with "Unknown command".
public cmd_h9_typing(id)
{
	if (id >= 1 && id < MAXPL && is_user_connected(id) && !is_user_bot(id))
	{
		new arg[4];
		read_argv(1, arg, charsmax(arg));
		set_typing(id, arg[0] == '1', "h9_typing");
	}
	return PLUGIN_HANDLED;
}

/// The chat line open or closed: the bubble up while it is open, every time it opens.
set_typing(id, bool:typing, const how[])
{
	if (typing)
	{
		// every word that it is open, the engine's repeats included, keeps the bubble up
		g_typing_at[id] = get_gametime();
		g_typing_cmd[id] = equal(how, "h9_typing") != 0;
	}
	if (typing == g_typing[id])
	{
		return;
	}
	g_typing[id] = typing;
	g_typing_team[id] = get_user_team(id);

	// Once a map, the proof that the engine's word arrives at all.
	if (typing && !g_typing_logged)
	{
		g_typing_logged = true;
		log_amx("[FC] %s: player %d opened the chat line, as the H9XASH engine reports it.", how, id);
	}
	if (typing && get_pcvar_num(g_cv_on) && get_pcvar_num(g_cv_typing))
	{
		bubble_entity(id);
	}
}

/// They sent it. The bubble comes down and the words go up.
public cmd_say(id)
{
	if (id >= 1 && id < MAXPL && !is_user_bot(id))
	{
		new cmd[16];
		read_args(cmd, charsmax(cmd));
		remove_quotes(cmd);
		trim(cmd);
		if (equali(cmd, ".bubbles"))
		{
			cmd_bubbles(id);
			return PLUGIN_HANDLED;
		}
	}

	if (!get_pcvar_num(g_cv_on))
	{
		return PLUGIN_CONTINUE;
	}
	// The line is sent, so the chat line is closed: the bubble goes at once, not on the next tick, so that the
	// words that follow never meet it.
	g_typing[id] = false;
	hide_bubble(id);

	if (is_user_bot(id) || !may_talk(id))
	{
		return PLUGIN_CONTINUE;
	}

	new said[192];
	read_args(said, charsmax(said));
	remove_quotes(said);
	trim(said);

	// Commands are not conversation. ts_matchmode's .ready, .team and the rest start with
	// a dot and would otherwise be broadcast over the speaker's head.
	if (!said[0] || said[0] == '.' || said[0] == '/')
	{
		return PLUGIN_CONTINUE;
	}

	if (!get_pcvar_num(g_cv_words))
	{
		return PLUGIN_CONTINUE;
	}

	// The hudmessage, for a client that cannot draw the words itself.
	if (get_pcvar_num(g_cv_hud))
	{
		new clean[128], lines, width;
		fc_tidy(said, clean, charsmax(clean), lines, width, clamp(get_pcvar_num(g_cv_maxchars), FC_MAXCHARS_MIN, FC_MAXCHARS_MAX), true);
		if (clean[0])
		{
			take_slot(id, clean, lines, width);
		}
	}

	// H9Say, for a client that draws it itself.
	if (get_pcvar_num(g_cv_bubble))
	{
		new verb[12];
		read_argv(0, verb, charsmax(verb));
		new words[FC_BUBBLE_RAW + 4], blines, bwidth;
		fc_tidy(said, words, charsmax(words), blines, bwidth, clamp(get_pcvar_num(g_cv_bubble_maxchars), FC_MAXCHARS_MIN, FC_BUBBLE_MAXCHARS_MAX), false);
		if (words[0])
		{
			send_bubble_words(id, words, equal(verb, "say_team") != 0);
		}
	}
	return PLUGIN_CONTINUE;
}

/// What the player said, made fit to float over a head, into out, cut to maxc characters; lines is 1 or 2 and
/// width the longer line's length. With split false the words stay one line (the client that draws them breaks
/// them to fit its box). See THE WORDS THEMSELVES.
fc_tidy(const said[], out[], len, &lines, &width, maxc, bool:split)
{
	if (maxc > len - 2)
	{
		maxc = len - 2;
	}

	// Control characters are spaces, a run of spaces is one, and the ends are trimmed.
	new tmp[FC_RAW_LEN + 4];
	new n = 0, letters = 0, lowers = 0;
	new bool:space = true;
	for (new i = 0; said[i] && n < FC_RAW_LEN; i++)
	{
		new c = said[i];
		if ((c >= 0 && c < 32) || c == 127)
		{
			c = ' ';
		}
		if (c == ' ')
		{
			if (!space)
			{
				tmp[n++] = ' ';
				space = true;
			}
			continue;
		}
		space = false;
		tmp[n++] = c;
		if (c >= 'a' && c <= 'z')
		{
			letters++;
			lowers++;
		}
		else if (c >= 'A' && c <= 'Z')
		{
			letters++;
		}
	}
	while (n > 0 && tmp[n - 1] == ' ')
	{
		n--;
	}
	tmp[n] = 0;

	// A line in capitals (four letters or more, none lower case) is set in sentence case.
	if (letters >= 4 && lowers == 0)
	{
		new bool:first = true;
		for (new i = 0; i < n; i++)
		{
			if (tmp[i] >= 'A' && tmp[i] <= 'Z')
			{
				if (!first)
				{
					tmp[i] += 32;
				}
				first = false;
			}
		}
	}

	// Too long: cut with "..." in the last three places, at a space if one is near, never inside a
	// multi-byte character.
	if (n > maxc)
	{
		new end = maxc - 3;
		new at = end;
		while (at > 0 && at > end - FC_CUT_BACK && tmp[at] != ' ')
		{
			at--;
		}
		if (at > 0 && tmp[at] == ' ')
		{
			end = at;
		}
		else
		{
			while (end > 0 && (tmp[end] & 0xC0) == 0x80)
			{
				end--;
			}
		}
		while (end > 0 && tmp[end - 1] == ' ')
		{
			end--;
		}
		n = end;
		tmp[n++] = '.';
		tmp[n++] = '.';
		tmp[n++] = '.';
		tmp[n] = 0;
	}

	lines = 1;
	width = n;
	new half = (maxc + 1) / 2;
	if (!split || n <= half)
	{
		copy(out, len, tmp);
		return;
	}

	// Two lines: broken at the space that makes the longer line shortest, as long as that line is within
	// FC_LINE_SLACK of half the limit; otherwise (a long word, no space) at half the limit itself.
	new brk = -1, best = 1000;
	for (new i = 1; i < n - 1; i++)
	{
		if (tmp[i] == ' ')
		{
			new longer = max(i, n - i - 1);
			if (longer < best)
			{
				best = longer;
				brk = i;
			}
		}
	}
	new skip = 1;
	if (brk < 0 || best > half + FC_LINE_SLACK)
	{
		brk = half;
		while (brk > 0 && (tmp[brk] & 0xC0) == 0x80)
		{
			brk--;
		}
		skip = 0;
	}
	new j = 0;
	for (new i = 0; i < brk && j < len - 1; i++)
	{
		out[j++] = tmp[i];
	}
	out[j++] = '^n';
	for (new i = brk + skip; i < n && j < len - 1; i++)
	{
		out[j++] = tmp[i];
	}
	out[j] = 0;
	lines = 2;
	width = max(brk, n - brk - skip);
}

/*
 * Puts a player's words in a channel, replacing their own if they are already in one.
 *
 * Replacing their own first matters: without it somebody talking quickly holds two of the
 * three slots and crowds everyone else out of the only channels we have.
 */
take_slot(id, const text[], lines, width)
{
	new Float:now = get_gametime();
	// fc_hold, and a little longer for a longer line
	new Float:hold = get_pcvar_float(g_cv_hold) + FC_HOLD_PER_CHAR * float(strlen(text));

	new pick = -1;
	for (new i = 0; i < FC_SLOTS; i++)
	{
		if (g_slot_owner[i] == id) { pick = i; break; }
	}
	if (pick < 0)
	{
		for (new i = 0; i < FC_SLOTS; i++)
		{
			if (g_slot_owner[i] == 0 || g_slot_until[i] <= now) { pick = i; break; }
		}
	}
	if (pick < 0)
	{
		// All three busy: the one closest to expiring gives way.
		new Float:soonest = 1.0e9;
		for (new i = 0; i < FC_SLOTS; i++)
		{
			if (g_slot_until[i] < soonest) { soonest = g_slot_until[i]; pick = i; }
		}
	}

	g_slot_owner[pick] = id;
	g_slot_until[pick] = now + hold;
	copy(g_slot_text[pick], charsmax(g_slot_text[]), text);
	g_slot_lines[pick] = lines;
	g_slot_width[pick] = width;
	head_tops(id, g_slot_top[pick]);

	// New words go out to every viewer on the next tick, wherever they were drawn before.
	for (new v = 1; v < MAXPL; v++)
	{
		g_sent_at[v][pick] = -1.0;
	}
}

/* ---- the words for a client that draws them ------------------------------ */

/// Whether this viewer is sent a talker's line as H9Say: his game draws the words itself, he has float chat on, he is
/// alive, and the line is not a team line of the other side (h9_floatchat_bubble_team). His own line only when
/// wants_own says so (fc_self, or his game asked).
bool:bubble_viewer(viewer, talker, bool:team_line, team)
{
	if (viewer < 1 || viewer >= MAXPL || !g_bubble_cli[viewer] || g_off[viewer] || !is_user_alive(viewer))
	{
		return false;
	}
	if (viewer == talker)
	{
		return wants_own(viewer);
	}
	return !(team_line && get_pcvar_num(g_cv_bubble_team) && get_user_team(viewer) != team);
}

/// One H9Say to one viewer, begun with fakemeta's EngFunc_MessageBegin as every plugin message is (Metamod-R
/// records only the game DLL's own). ttl 0 takes a line down: slot 0 every line, else that speaker's.
bubble_msg(viewer, slot, flags, ttl, range, stand, duck, const words[])
{
	engfunc(EngFunc_MessageBegin, MSG_ONE_UNRELIABLE, g_msg_say, Float:{0.0, 0.0, 0.0}, viewer);
	write_byte(slot);
	write_byte(flags);
	write_short(ttl);
	write_short(range);
	write_byte(stand);
	write_byte(duck);
	write_string(words);
	message_end();
}

/// Takes every line down on one viewer's screen, for a game that draws them itself.
bubble_clear_msg(viewer, slot)
{
	if (g_msg_say && viewer >= 1 && viewer < MAXPL && g_bubble_cli[viewer] && is_user_connected(viewer))
	{
		bubble_msg(viewer, slot, 0, 0, 0, 0, 0, "");
	}
}

/// Takes a speaker's line down for every viewer whose game draws the words itself.
send_bubble_clear(talker)
{
	if (!g_msg_say)
	{
		return;
	}
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		bubble_clear_msg(players[i], talker);
	}
}

/// A talker's words, sent once to every viewer whose game draws them itself (THE WORDS, FOR A CLIENT THAT DRAWS THEM).
send_bubble_words(talker, const words[], bool:team_line)
{
	if (!g_msg_say || talker < 1 || talker >= MAXPL)
	{
		return;
	}

	// h9_floatchat_bubble_hold seconds when it is set, else fc_hold and a little longer for a longer line, as the
	// hudmessage holds it
	new Float:hold = get_pcvar_float(g_cv_bubble_hold);
	if (hold > FC_BUBBLE_HOLD_MAX)
	{
		hold = FC_BUBBLE_HOLD_MAX;
	}
	else if (hold > 0.0 && hold < 1.0)
	{
		hold = 1.0;
	}
	if (hold <= 0.0)
	{
		hold = get_pcvar_float(g_cv_hold) + FC_HOLD_PER_CHAR * float(strlen(words));
	}
	new ttl = clamp(floatround(hold * 10.0), 1, 300);
	new range = clamp(floatround(get_pcvar_float(g_cv_range)), 64, 8192);

	new Float:tops[2];
	head_tops(talker, tops);
	new stand = clamp(floatround(tops[0]), 1, 255);
	new duck = clamp(floatround(tops[1]), 1, 255);

	new flags = team_line ? FC_MSG_F_TEAM : 0;
	new team = get_user_team(talker);

	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");
	for (new i = 0; i < pnum; i++)
	{
		if (bubble_viewer(players[i], talker, team_line, team))
		{
			bubble_msg(players[i], talker, flags, ttl, range, stand, duck, words);
		}
	}
	g_say_until[talker] = get_gametime() + float(ttl) * 0.1;
}

/* ---- drawing, ten times a second ----------------------------------------- */

public task_float()
{
	if (!get_pcvar_num(g_cv_on))
	{
		return;
	}

	new Float:now = get_gametime();
	new players[MAX_PLAYERS], pnum;
	get_players(players, pnum, "ch");   // connected humans only; a bot answers no menu and reads no text

	// The AddToFullPack hooks follow who has float chat off, who is typing, and fc_self.
	update_afp_hook(0);

	// A line the clients that draw the words themselves hold comes down early when its speaker stops being shown.
	for (new i = 1; i < MAXPL; i++)
	{
		if (g_say_until[i] <= 0.0)
		{
			continue;
		}
		if (g_say_until[i] <= now)
		{
			g_say_until[i] = 0.0;
		}
		else if (!is_user_connected(i) || !may_talk(i))
		{
			g_say_until[i] = 0.0;
			send_bubble_clear(i);
		}
	}

	// A BUBBLE NEVER HANGS: no word for a while, death, leaving the match, a new team.
	for (new i = 0; i < pnum; i++)
	{
		new p = players[i];
		if (!g_typing[p])
		{
			continue;
		}
		new Float:quiet = g_typing_cmd[p] ? FC_TYPING_QUIET : FC_TYPING_QUIET_OLD;
		if (now - g_typing_at[p] > quiet || !may_talk(p) || get_user_team(p) != g_typing_team[p])
		{
			g_typing[p] = false;
		}
	}

	// The bubbles first: they are world objects and need no viewer.
	for (new i = 0; i < pnum; i++)
	{
		place_bubble(players[i], now);
	}

	// Then the words, which have to be worked out for each viewer separately.
	new bool:hud_words = get_pcvar_num(g_cv_words) && get_pcvar_num(g_cv_hud);
	for (new s = 0; s < FC_SLOTS; s++)
	{
		new talker = g_slot_owner[s];
		if (talker < 1 || g_slot_until[s] <= now || !hud_words)
		{
			g_slot_owner[s] = 0;
			continue;
		}
		if (!is_user_connected(talker) || !may_talk(talker))
		{
			g_slot_owner[s] = 0;
			continue;
		}
		for (new i = 0; i < pnum; i++)
		{
			draw_for(players[i], talker, s);
		}
	}
}

/// The bubble, above the head, shown while they are typing and animated as it goes.
place_bubble(id, Float:now)
{
	new ent = g_bubble[id];
	if (ent < 1 || !pev_valid(ent))
	{
		return;
	}

	if (!g_typing[id] || !may_talk(id) || !get_pcvar_num(g_cv_typing))
	{
		set_pev(ent, pev_effects, pev(ent, pev_effects) | FC_EF_NODRAW);
		return;
	}

	new Float:org[3];
	bubble_anchor(id, org);
	engfunc(EngFunc_SetOrigin, ent, org);

	set_pev(ent, pev_scale, get_pcvar_float(g_cv_scale));
	// Four frames at ten ticks a second is a dot every two ticks, which reads as typing
	// rather than as a strobe.
	set_pev(ent, pev_frame, float((floatround(now * 5.0)) % FC_FRAMES));
	set_pev(ent, pev_effects, pev(ent, pev_effects) & ~FC_EF_NODRAW);
}

/*
 * One talker's words, placed on one viewer's screen.
 *
 * THE PROJECTION. A hudmessage is positioned in screen fractions, so the point above the
 * talker's bubble has to be turned into a point on this viewer's screen (head_on_screen):
 *
 *   d          = that point - viewer's eye
 *   forward/right/up come from the VIEWER's own v_angle
 *   behind them (d . forward <= 0)  -> nothing to draw
 *   sx = (d.right) / (d.forward) / tan(fov/2)
 *   sy = (d.up)    / (d.forward) / (tan(fov/2) * 0.75)
 *
 * The fov is a 4:3 view's width, so its height's half-angle is tan(fov/2) * 3/4. The server is
 * never told the viewer's screen shape: 4:3 is assumed and fc_y_tweak corrects it. The box is then
 * centred on the point and rests on it, its width guessed from the line's length.
 */
draw_for(viewer, talker, slot)
{
	// A viewer who has float chat off is sent nothing at all.
	if (viewer >= MAXPL || g_off[viewer] || !is_user_alive(viewer))
	{
		return;
	}

	// One whose game draws the words itself was sent them as H9Say when they were said.
	if (g_bubble_cli[viewer] && get_pcvar_num(g_cv_bubble))
	{
		return;
	}

	new Float:hx, Float:hy;
	if (viewer == talker)
	{
		// His own words, only when wants_own says so: fc_self 1, or his game asked while h9_floatchat_bubble is 0, which
		// leaves even a game that draws the words the hudmessage. Centred near the top of his own screen.
		if (!wants_own(viewer))
		{
			return;
		}
		hx = -1.0;   // a hudmessage at -1 is centred across the screen
		hy = FC_SELF_Y;
	}
	else if (!head_on_screen(viewer, talker, slot, hx, hy))
	{
		return;
	}
	else
	{
		// The box rests on the point above the head and is centred on it: a hudmessage's x and y are
		// its left and its top.
		hx -= float(g_slot_width[slot]) * FC_CHAR_W * 0.5;
		hy -= float(g_slot_lines[slot]) * FC_LINE_H;
		if (hx < 0.0)
		{
			hx = 0.0;
		}
		if (hy < 0.0)
		{
			hy = 0.0;
		}
	}

	/*
	 * Sent again only when it has moved on this viewer's screen, or before the last one runs out.
	 * The hold is 0.25 s, so a line that stands still on his screen goes out about five times a
	 * second instead of ten, and one that moves as he turns still follows every tick.
	 */
	new Float:now = get_gametime();
	if (floatabs(hx - g_sent_x[viewer][slot]) < 0.004 && floatabs(hy - g_sent_y[viewer][slot]) < 0.004
		&& g_sent_at[viewer][slot] >= 0.0 && now - g_sent_at[viewer][slot] < 0.18)
	{
		return;
	}
	g_sent_x[viewer][slot] = hx;
	g_sent_y[viewer][slot] = hy;
	g_sent_at[viewer][slot] = now;

	// Held a little longer than the tick that draws it, so it does not flicker between
	// updates, and faded by nothing -- a fade would restart on every re-send.
	set_hudmessage(get_pcvar_num(g_cv_r), get_pcvar_num(g_cv_g), get_pcvar_num(g_cv_b),
		hx, hy, 0, 0.0, 0.25, 0.0, 0.0, FC_CHANNELS[slot]);
	show_hudmessage(viewer, "%s", g_slot_text[slot]);
}

/// Where the point above the talker's head is on this viewer's screen, as fractions in hx and hy.
/// False when it is out of fc_range, behind a wall, behind the viewer or off the edge of his screen.
bool:head_on_screen(viewer, talker, slot, &Float:hx, &Float:hy)
{
	new Float:eye[3], Float:ofs[3], Float:head[3];
	pev(viewer, pev_origin, eye);
	pev(viewer, pev_view_ofs, ofs);
	eye[0] += ofs[0]; eye[1] += ofs[1]; eye[2] += ofs[2];

	words_anchor(talker, slot, head);

	new Float:d[3];
	for (new k = 0; k < 3; k++)
	{
		d[k] = head[k] - eye[k];
	}
	new Float:dist = floatsqroot(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
	if (dist > get_pcvar_float(g_cv_range) || dist < 1.0)
	{
		return false;
	}

	// Nothing through walls. Cheap enough ten times a second for the few pairs that get
	// this far, and without it the whole thing becomes a wallhack. Players do not count: the point is
	// just over the talker's head, and a close viewer's line to it would clip his own hull.
	new tr = 0;
	engfunc(EngFunc_TraceLine, eye, head, IGNORE_MONSTERS, viewer, tr);
	if (get_tr2(tr, TR_flFraction) < 0.95)
	{
		return false;
	}

	new Float:ang[3];
	pev(viewer, pev_v_angle, ang);
	new Float:fwd[3], Float:right[3], Float:up[3];
	engfunc(EngFunc_MakeVectors, ang);
	global_get(glb_v_forward, fwd);
	global_get(glb_v_right,   right);
	global_get(glb_v_up,      up);

	new Float:df = d[0] * fwd[0]   + d[1] * fwd[1]   + d[2] * fwd[2];
	if (df <= 1.0)
	{
		return false;   // behind the viewer, or so close the projection blows up
	}
	new Float:dr = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
	new Float:du = d[0] * up[0]    + d[1] * up[1]    + d[2] * up[2];

	// The viewer's own field of view; 0 is the engine's default of 90.
	new Float:fov = float(pev(viewer, pev_fov));
	if (fov < 1.0) { fov = 90.0; }
	new Float:half = floattan(fov / 2.0, degrees);
	if (half < 0.01) { half = 1.0; }

	// The engine's fov is the width of a 4:3 view, so the view's vertical half-angle is that of
	// its 3:4 height: tan(fov/2) times 0.75. fc_y_tweak nudges it for a screen of another shape.
	new Float:sx = (dr / df) / half;
	new Float:sy = (du / df) / (half * 0.75) * get_pcvar_float(g_cv_ytweak);

	hx = 0.5 + 0.5 * sx;
	hy = 0.5 - 0.5 * sy;
	if (hx < 0.02 || hx > 0.98 || hy < 0.02 || hy > 0.98)
	{
		return false;   // off the edge of their screen
	}
	return true;
}
