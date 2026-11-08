/*
 * h9_presence.sma -- tells havoc9.org who is in game on this server
 *
 * Every 60 seconds, and a few seconds after anyone joins, leaves or changes name, this POSTs a
 * report to h9web's presence module (https://havoc9.org/api/presence/report): the map, the mode
 * (named the way the engine's Discord card names it, its sides by the names the game itself shows:
 * entries 1 and 2 of mp_teamlist, "Middle Sea Republic" and "Insurrectionists" on H9XASH, else
 * ts_matchmode's tsm_team1_name and tsm_team2_name), and for every human player with an
 * h9_clientid that id, the name, the join time and the time in game. Bots and HLTV are left out.
 * h9web keeps only the players whose h9_clientid belongs to a havoc9.org account and drops every
 * other id at once. docs\H9_PRESENCE.txt is the guide; docs\H9_COMMUNITIES.txt for communities.
 *
 * THE KEY. Each server has its own key, and every report carries X-H9-Signature: HMAC-SHA256
 * over the exact body, keyed with it, and a timestamp later than the last one, so a report cannot
 * be forged, altered or replayed. A dedicated server gets its key by itself (ENROLLMENT, below); a
 * key made by hand with h9web's presence-key.js, put in h9_presence.cfg with h9_presence_server,
 * wins over it. The cvar is protected, and the key is never logged or printed.
 *
 * ENROLLMENT (h9_presence_autoenroll 1, the default; never on a listen server). The plugin asks
 * h9web for a key for its own address (the IP h9web sees and this server's port). The key comes
 * back inactive, with a code the plugin puts in h9_presence_enroll, an FCVAR_SERVER cvar (and
 * FCVAR_UNLOGGED: no "changed to" line for anyone). h9web reads the server's rules over UDP; the
 * code there proves the address is this server, and the key goes live (an H9 admin approves a
 * server that is not on h9web's list first). The key, the address, the public server id and the
 * enrollment's state are kept in addons/amxmodx/data/h9_presence.key, which client packages and
 * git leave out. A server h9web cannot reach (behind NAT, on a LAN) stays unenrolled and asks
 * again less and less often, from 10 seconds to every 6 hours, without a word in the console.
 *
 * CREATE GAME (a listen server). Its own player joins over loopback, which has no address, so the
 * plugin tells that player's game the address the server reports as (h9_idlisten <address>; H9XASH
 * with engine-h9-listen.patch, _h9idl 1 in its userinfo): the game then salts its h9_clientid with
 * it, as a player joining from elsewhere has it, and proves its id for it (h9_idlisten <address>
 * <nonce>, in place of h9_idchallenge). With no hand-made key, the listen server enrolls once its own
 * player is in game: h9web gives a key and a nonce for the caller's IP and this port ({ listen: true }),
 * the player's game answers the nonce, and that proof makes the key live at once, no rules probe and
 * no admin. h9web counts proven players only on such a server and never shows its address. Its state
 * is kept in addons/amxmodx/data/h9_presence_listen.key, apart from a dedicated server's.
 *
 * KICKS AND MUTES. h9web's answer to each report says which players to kick (a ban of their
 * account, in this server's community or H9-wide, or a one-off kick) and which are muted; a muted
 * player's chat goes nowhere. On a members-only server ("members": true in the answer) the report
 * lists every player, by slot alone when there is no usable h9_clientid, and h9web names whoever
 * is not a member of the server's community, to be kicked with a link to join.
 *
 * FOR OTHER PLUGINS: natives h9p_ready, h9p_server, h9p_server_id, h9p_api, h9p_sign, h9p_nonce,
 * h9p_report_soon and h9p_muted (include/h9_community.inc), which h9_community.sma uses.
 *
 * ACCOUNTS FOR OTHER PLUGINS (1.9, include/h9_presence.inc). h9p_account(id) is the slot's proven
 * havoc9.org account, its number on the site (accounts.id), 0 for none: the same players as the
 * green chain, so only a game that proved its player id (THE PROOF, below) ever has one, a second or
 * two after it is in game (QUICK JOINS). h9p_account_name gives the account's current username and
 * h9p_roles its roles here, both from h9web's answer ("usernames", "roles"): "h9_admin" or
 * "h9_moderator" (its role on the site), then "owner", "staff" and "member" in this server's
 * community. The forward h9p_account_changed(id, account) comes whenever any of the three changes for
 * a slot: the answer that proves it, a rename or a new role on the site, an id that changes in game
 * (account 0) and a player leaving (account 0). Nothing is kept across a map change: the map's first
 * answer says it all again.
 *
 * THE PROOF (h9_presence_challenge 1, once the engine answers it). h9_clientid is the same value
 * for a player every time and every player on the server can read it, so on its own it proves
 * nothing. A client that advertises _h9idv 1 in its userinfo gets a one-time nonce, which h9web
 * issues for it (POST .../server/nonce, signed), as h9_idchallenge <nonce>, and answers with
 * HMAC-SHA256(its raw player id, nonce + this server's address) and its masked device id
 * (h9_idproof <nonce> <devmask> <proof>); its own player on a listen server gets h9_idlisten instead
 * (CREATE GAME, above). The plugin reports the answer to its own challenge only,
 * and h9web checks it: a proof counts while its nonce is younger than 10 minutes, so every player
 * is challenged again every 5 (RECHALLENGE), the last proof reported until the next one answers.
 * A game whose h9_clientid, _h9idv or _h9lnk changes while it plays (h9_unlink in it, or a REVOKE
 * on the site it heard of, gives it a new id) loses its proof at once: every client hears that the
 * slot is no proven account (H9Link 0, the red chain; the silhouette; no account; no level), the
 * game is challenged again (at most once in IDCHAL_GAP seconds), and h9web hears soon.
 * Every answer also goes to other plugins (the h9p_proof forward), and h9p_challenge sends a
 * plugin's own nonce. Off by default.
 *
 * PICTURES. h9web's answer to each report names the havoc9.org picture of each proven player
 * ("avatars": slot, account and version: their own picture, or the site's default one), and the
 * plugin tells every client in the H9Avatar user message (byte slot, long account, long version;
 * account 0: none), a joining client the whole table, and every client when a slot empties.
 * H9XASH fetches the picture from havoc9.org itself (engine-h9-avatars.patch) for the scoreboard;
 * other clients ignore the message. The same players are "linked" in the H9Link user message
 * (byte slot, byte 1 linked, 0 not, 2 a bot), which H9's client.dll (on H9XASH and on Steam alike)
 * shows on the scoreboard as a green chain, a red broken one, or H9's grey helmet for a bot.
 * The same players' havoc9.org levels ("levels": slot and level, Lv 0 to 99 from the H9 ladder,
 * docs\H9_COMPETITIVE.txt) go in the H9Level user message (byte slot, byte level; 255: none),
 * which H9's client.dll draws as "Lv N" by the name; a joining client gets the whole table.
 * The same players' own account numbers ("accounts": slot and account, only the slots with the
 * chain) go in the H9Account user message (byte slot, long account; 0: none), which H9XASH keeps
 * for h9_profile, the scoreboard's double-click on a linked player's picture
 * (engine-h9-avatars.patch): it opens that account's havoc9.org profile, a player on the site's
 * default picture included. A joining client gets the whole table, and every client hears when a
 * slot empties. Each map starts with an empty table, so the map's first answer tells every client
 * every slot's picture and account again, and a game asks again for a picture it could not fetch.
 *
 * QUICK JOINS (1.8). A proof's answer is reported at once (PROOF_REPORT), never later than the next
 * report already due, and one report goes every FAST_GAP seconds at most, so a proven player's
 * chain, picture and level reach every scoreboard a second or two after the player is in game, at a
 * map's start too (where the first report waits FIRST_DELAY, FIRST_EMPTY on a server nobody is on, only while nobody has
 * proved anything: a server that has just started is authenticated a few seconds after its plugins are up);
 * a joining client gets the others' table after a second; and a slot is challenged at most once in
 * CHAL_GAP seconds, so reconnecting quickly asks h9web for no more nonces.
 *
 * TASK IDS. The per-slot tasks (the table to a joining client, h9_require_account's check, a changed
 * id's challenge) each have a range of their own, 200 apart, so at 128 slots no slot's task is
 * another's (before 1.7 the first two met from slot 100 up).
 *
 * ACCOUNTS ONLY (h9_require_account 1, an FCVAR_SERVER cvar, so it is in the server's rules and, on
 * H9XASH, in its server-browser answer as auth 1). Every game is challenged, whatever
 * h9_presence_challenge says. A game that cannot prove a havoc9.org account (no _h9idv 1 in its
 * userinfo, or no h9_clientid: a Steam client, an older H9XASH, a game with no player id) is kicked
 * at once; one that can gets h9_require_account_grace seconds (45) to prove it, and is kicked if it
 * has not. The kick says why: "This server requires a havoc9.org account: link your game from the
 * main menu". It fails open: while h9web has not answered a report lately (2 report intervals), and
 * while it has given a player no challenge, nobody is kicked for it, and the check comes again later.
 * The listen server's own player and bots are never kicked for it.
 *
 * A LISTEN SERVER'S OWN PLAYER. Its report names that player's slot ("host"), and h9web answers
 * how it knows that player ("host": "proven", "known" or "unknown"); the plugin logs each change
 * and h9_presence_status shows it, so a game whose player id is not its account's says so.
 *
 * NAMES (h9_presence_names 1, which needs h9_presence_challenge 1). On every map but roleplay
 * maps (roleplay_map(), as ts_matchmode.sma has it) and stock ts_ maps, the report asks h9web
 * for names: a proven account plays under its havoc9.org username, set on join and on every map
 * change and put back at once when changed in game, and anyone else using an account's name
 * (look-alikes included) plays as "Player 1234". One short chat line says why. Off by default.
 *
 * WHY THE PLUGIN HAS ITS OWN SHA-256. AMXX's hash_string takes text up to its first zero byte, and
 * the second half of an HMAC hashes raw bytes. sha_* below is FIPS 180-4 SHA-256 over bytes held
 * one per cell; it checks itself against the FIPS and RFC 4231 test vectors and against
 * hash_string when the plugin loads, and a plugin that fails the check never reports.
 *
 * WHAT THIS SERVER RUNS. At each map start, and again every 20 minutes, the report lists every AMX Mod
 * X plugin that loaded, every AMX Mod X module in the modules folder and every Metamod plugin that
 * metamod's plugins.ini names and that is there: the file's name, a plugin's version and the SHA-256 of
 * the file. h9web checks the list against H9's official preset (docs/H9_PRESENCE.txt, section 4d): a
 * server that runs only that is authenticated (the server browser's green chain, and its matches are
 * rated); one that runs anything else is not (the red chain), and nothing is blocked or kicked.
 * h9_authenticated 0 opts out on purpose: the report says authenticated: false, h9web lists the server
 * as not authenticated and rates nothing. 1, the default, asks for nothing: h9web still judges what the
 * server runs, and no setting makes a server more authenticated than that.
 *
 * Needs the AmxxEasyHttp module and its CA bundle, as ts_advertise does:
 *     addons/amxmodx/modules/easy_http_amxx.dll
 *     addons/amxmodx/data/amxx_easy_http_cacert.pem
 *
 * Written to the same rules as ts_matchmode.sma, for a strict compiler: explicit tags, braces on
 * every block, and no backslash escapes in strings (a backslash is written as the number 92).
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <easy_http>
#include <h9_release>     // H9_RELEASE: the release these plugins are, written by build.bat from the game's h9_release.txt

#pragma dynamic 8192

#define PLUGIN  "H9 Presence"
#define VERSION "1.11"
#define AUTHOR  "2cwldys"

#define MAX_BODY        (MAX_PLAYERS * ROOM_PER_PLAYER + 2048)   // the largest report, in bytes: every
                                // slot's entry at its largest, plus the rest (h9web takes up to 131072)
#define ROOM_PER_PLAYER 640     // the most one player's entry can take, escaped
#define REPORT_DELAY    3.0     // seconds after a join, a leave or a new name before the report
#define FIRST_DELAY     15.0    // seconds after the map starts before the first report, with players in the game to prove themselves
#define FIRST_EMPTY     3.0     // the same with nobody in the game: a server that has just started is authenticated after this
#define PROOF_REPORT    0.3     // seconds after a proof's answer before the report that carries it
#define FAST_GAP        2.0     // seconds between two reports at the least (h9web takes 40 a minute)
#define CHAL_GAP        2       // seconds between two challenges of one slot at the least
#define PROOF_WAIT      8       // seconds a challenged player is left out while its answer comes
#define RECHALLENGE     300     // seconds before a player is challenged again (h9web takes 10 minutes)
#define COMP_MAX        160     // the most files the report lists (h9web takes 400)
#define COMP_EVERY      1200    // seconds between one accepted list of what the server runs and the next

// task ids: the single ones, then each per-slot range (+ slot, 1 to MAX_PLAYERS, 128 at most) 200
// apart, so no two ever meet
#define TASK_TICK  59200
#define TASK_SOON  59201
#define TASK_ENROLL 59202
#define TASK_REQUIRE 59600               // + slot: h9_require_account's check after the grace period

new g_cv_url, g_cv_server, g_cv_key, g_cv_interval, g_cv_challenge, g_cv_names, g_cv_enroll, g_cv_autoenroll;
new g_cv_require, g_cv_require_grace;    // h9_require_account and its grace period
new g_cv_auth;                           // h9_authenticated: 0 asks h9web not to authenticate or rate this server
new bool:g_auth_flight = true;           // whether the report just built says the server is authenticated (the cvar not 0)
new const REQUIRE_REASON[] = "This server requires a havoc9.org account: link your game from the main menu";
// ts_matchmode's tsm_pres_* cvars, the Discord card's source (0 when ts_matchmode is not loaded)
new g_cv_mode, g_cv_siege, g_cv_attack, g_cv_prog;

new g_max;
new bool:g_in[MAX_PLAYERS + 1];          // a person put in the server (not a bot or HLTV)
new g_joined[MAX_PLAYERS + 1];           // unix time of client_putinserver
new g_nonce[MAX_PLAYERS + 1][33];        // the challenge this slot was given
new g_asked[MAX_PLAYERS + 1];            // when
new g_devmask[MAX_PLAYERS + 1][33];      // its answer to that challenge
new g_proof[MAX_PLAYERS + 1][65];
new g_gen[MAX_PLAYERS + 1];              // counts who held the slot, so a late answer finds the right player
new g_sent_gen[MAX_PLAYERS + 1];         // g_gen as the report in flight saw it

// Names (h9_presence_names): on this map a proven account plays under its havoc9.org username, and
// nobody else under a registered one. h9web says which, per slot, in its answer to a report.
new bool:g_names = false;
new g_forced[MAX_PLAYERS + 1][64];       // the name the slot plays under on this map, or ""
new bool:g_neutral[MAX_PLAYERS + 1];     // g_forced is a neutral name: its own was an account's
new g_told[MAX_PLAYERS + 1];             // when the slot was last told why (one line in 10 seconds)

new bool:g_ready = false;                // configured, and the self-test passed
new bool:g_selftest = false;
new bool:g_sending = false;              // a report in flight
new Float:g_soon_due = 0.0;              // get_gametime() the report waiting in TASK_SOON goes at
new Float:g_report_at = -100.0;          // get_gametime() the last report went at
new g_chal_last[MAX_PLAYERS + 1];        // when each slot was last challenged (kept across its players)
new bool:g_again = false;                // something changed while it was in flight
new g_last_ts = 0;                       // the ts of the last report built
new g_last_count = -1;                   // players in the last accepted report (-1: none yet)
new g_last_status = 0;                   // the last outcome logged: 200, a status, or -1
new g_backoff_until = 0;
new g_sent_count = 0;
new g_accepted = 0;                      // reports accepted since the map started
new g_left_out = 0;                      // players left out of the last report for room

// What the server runs (collect_components, once a map): 0 an AMX Mod X plugin, 1 a module, 2 a Metamod plugin
new const COMP_KIND[][] = { "amxx", "module", "meta" };
new g_comp_n = 0;
new g_comp_kind[COMP_MAX];
new g_comp_file[COMP_MAX][48];
new g_comp_ver[COMP_MAX][24];
new g_comp_hash[COMP_MAX][65];           // SHA-256 as 64 hex, or empty when the file could not be read
new bool:g_comp_due = true;              // the next report carries the list
new bool:g_comp_sent = false;            // the report in flight carries it
new g_comp_at = 0;                       // when h9web last took it

new g_body[MAX_BODY];                    // the report, one byte per cell
new g_len;
new g_ids[MAX_PLAYERS + 1][33];
new g_who[MAX_PLAYERS + 1];
new bool:g_hasid[MAX_PLAYERS + 1];
new g_scratch[300];

// The key and the address reports are signed for: a hand-made pair from h9_presence.cfg, or the
// pair this server enrolled with, kept with its server id and the enrollment's state in
// data/h9_presence.key across map changes and restarts.
new g_key[72], g_server[48], g_serverid[16], g_code[24];
new bool:g_manual = false;
#define ES_NONE     0    // no key: enroll
#define ES_PROOF    1    // a key, inactive: the code is in h9_presence_enroll until h9web has seen it
#define ES_APPROVAL 2    // proven; an H9 admin approves it first (a server not on servers.json)
#define ES_ACTIVE   3    // live: reports go out
new g_estate = ES_NONE;
new g_enext = 0;                         // when the next enrollment step may run (unix time)
new g_etries = 0;                        // steps in a row that failed or waited (the backoff)
new bool:g_ebusy = false;                // an enrollment request in flight
new bool:g_listen = false;               // a listen server enrolling by its own player's ID proof
new g_lnonce[40];                        // the nonce that player proves this address with
new g_lhost = 0;                         // that player's slot, and who held it (g_gen)
new g_lgen = 0;
new g_bad = 0;                           // reports refused in a row because of the key
new bool:g_muted[MAX_PLAYERS + 1];       // h9web says this slot's account is muted here
new g_mute_told[MAX_PLAYERS + 1];
// members-only servers: h9web's answers say so, and then every player goes in the report
new bool:g_members = false;
new g_signbuf[MAX_BODY];                 // what another plugin asks h9p_sign to sign
new g_pnonce[MAX_PLAYERS + 1][33];       // the nonce the slot's proof answers (g_nonce: the one asked)
new bool:g_fetching[MAX_PLAYERS + 1];    // a nonce on its way from h9web for the slot
new g_fwd_proof;                         // h9p_proof, every answer for other plugins
new g_msg_avatar;                        // H9Avatar, 0 when it could not be registered
new g_msg_link;                          // H9Link, 0 when it could not be registered
new bool:g_linked[MAX_PLAYERS + 1];      // what every client was last told: a proven account here
new g_msg_level;                         // H9Level, 0 when it could not be registered
new g_level[MAX_PLAYERS + 1];            // the level every client was last told for each slot, + 1 (0: none)
new g_msg_account;                       // H9Account, 0 when it could not be registered
new g_acct[MAX_PLAYERS + 1];             // the account every client was last told for each linked slot (0: none)
new g_uname[MAX_PLAYERS + 1][64];        // that account's username on havoc9.org, for h9p_account_name ("": none)
new g_roles[MAX_PLAYERS + 1][96];        // its roles here, for h9p_roles ("": none)
new g_fwd_account;                       // h9p_account_changed: what h9p_account, _name or h9p_roles say changed
new g_idinfo[MAX_PLAYERS + 1][80];       // h9_clientid, _h9idv and _h9lnk as the slot's game last had them
new g_idchal_at[MAX_PLAYERS + 1];        // when a change of them last had the slot challenged
#define TASK_IDCHAL 59800                // + slot: that challenge, when the one before was too recent
#define IDCHAL_GAP  10                   // seconds between two challenges a change of them asks for
new bool:g_isbot[MAX_PLAYERS + 1];       // a bot in the slot: H9Link says 2, never a chain
new g_hoststate[16];                     // h9web's word on this listen server's own player, or ""
new g_answered_at = 0;                   // when h9web last took a report (h9_require_account fails open without)
new bool:g_proven[MAX_PLAYERS + 1];      // the answer's "proven": the slot proved a havoc9.org account
new g_av_account[MAX_PLAYERS + 1];       // the picture every client was last told for each slot
new g_av_version[MAX_PLAYERS + 1];
#define TASK_AVATARS 59400               // + slot: the table to a client that just joined
new const BACKOFF[] = { 10, 30, 60, 120, 300, 900, 1800, 3600, 21600 };

new const HEX[] = "0123456789abcdef";

public plugin_precache()
{
	// Begun with fakemeta's EngFunc_MessageBegin: AMX Mod X's message_begin refuses a
	// message a plugin registered, because Metamod-R records only the game DLL's own.
	// the scoreboard's pictures: byte slot, long account, long version (engine-h9-avatars.patch)
	g_msg_avatar = engfunc(EngFunc_RegUserMsg, "H9Avatar", 9);
	// the scoreboard's chain: byte slot, byte linked (H9's client.dll)
	g_msg_link = engfunc(EngFunc_RegUserMsg, "H9Link", 2);
	// the scoreboard's level: byte slot, byte level 0 to 99, 255 none (H9's client.dll)
	g_msg_level = engfunc(EngFunc_RegUserMsg, "H9Level", 2);
	// a linked player's own account, for the scoreboard's double-click: byte slot, long account
	// (engine-h9-avatars.patch's h9_profile)
	g_msg_account = engfunc(EngFunc_RegUserMsg, "H9Account", 5);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cv_url       = register_cvar("h9_presence_url", "https://havoc9.org/api/presence/report");
	g_cv_server    = register_cvar("h9_presence_server", "");
	// The key signs this server's reports. FCVAR_PROTECTED keeps its value out of cvar
	// listings and amx_cvar; the plugin never logs or prints it.
	g_cv_key       = register_cvar("h9_presence_key", "", FCVAR_PROTECTED);
	g_cv_interval  = register_cvar("h9_presence_interval", "60");
	g_cv_challenge = register_cvar("h9_presence_challenge", "1");
	g_cv_names     = register_cvar("h9_presence_names", "0");
	// The enrollment code: in the server's rules (FCVAR_SERVER) while h9web looks for it there.
	// FCVAR_UNLOGGED keeps each change out of the log and off every player's screen.
	g_cv_enroll     = register_cvar("h9_presence_enroll", "", FCVAR_SERVER | FCVAR_UNLOGGED);
	g_cv_autoenroll = register_cvar("h9_presence_autoenroll", "1");
	// Accounts only. FCVAR_SERVER: in the server's rules, and the engine's server-browser answer
	// says auth 1 while it is 1 (engine-h9-serverinfo.patch).
	g_cv_require       = register_cvar("h9_require_account", "0", FCVAR_SERVER);
	g_cv_require_grace = register_cvar("h9_require_account_grace", "45");
	// The release gate, which the engine's join (engine-h9-serverinfo.patch, SV_H9ReleaseRefusal) reads: h9_require_release 1 refuses a
	// joiner whose H9 game is another release than this server's, with where to get his; 2 asks every joiner for the release (a stock
	// client has none); 0 lets everyone in. h9_plugin_release is the release these plugins are, which is what joiners are held to
	// (the game folder's h9_release.txt when it is empty). FCVAR_SERVER: in the rules, and the browser can see them.
	register_cvar("h9_require_release", "1", FCVAR_SERVER);
	register_cvar("h9_plugin_release", H9_RELEASE, FCVAR_SERVER);
	// h9_authenticated 0 opts this server out of being authenticated and rated (the report says
	// authenticated: false). 1 asks for nothing: h9web judges what the server runs. FCVAR_SERVER: in the rules.
	g_cv_auth = register_cvar("h9_authenticated", "1", FCVAR_SERVER);

	register_clcmd("h9_idproof", "cmd_idproof");
	g_fwd_proof = CreateMultiForward("h9p_proof", ET_IGNORE, FP_CELL, FP_STRING, FP_STRING, FP_STRING);
	g_fwd_account = CreateMultiForward("h9p_account_changed", ET_IGNORE, FP_CELL, FP_CELL);
	register_clcmd("say", "hook_say");
	register_clcmd("say_team", "hook_say");
	register_srvcmd("h9_presence_status", "cmd_status");

	g_max = get_maxplayers();
	if (g_max > MAX_PLAYERS)
	{
		g_max = MAX_PLAYERS;
	}

	g_selftest = self_test();
	if (!g_selftest)
	{
		log_amx("[PRESENCE] The plugin's SHA-256 failed its self-test. Nothing will be reported. Tell whoever builds H9's plugins.");
	}
}

/// The release the plugins carry against the game folder's own h9_release.txt: the engine holds joiners to the plugins', so a folder that
/// says another is a package half updated, and is told in the log.
check_release()
{
	new have[32], want[32];
	new f = fopen("h9_release.txt", "rt", true);
	if (f)
	{
		new line[64];
		fgets(f, line, charsmax(line));
		fclose(f);
		parse(line, have, charsmax(have));
	}
	get_cvar_string("h9_plugin_release", want, charsmax(want));
	if (!want[0])
	{
		log_amx("[H9] these plugins carry no release (h9_plugin_release is empty): the game folder's h9_release.txt (%s) is what joiners are held to.", have[0] ? have : "none");
	}
	else if (have[0] && !equal(have, want))
	{
		log_amx("[H9] PACKAGE MISMATCH: the plugins are release %s and the game folder's h9_release.txt says %s. h9_require_release holds joiners to %s.", want, have, want);
	}
	else
	{
		log_amx("[H9] release %s (h9_require_release %d).", want, get_cvar_num("h9_require_release"));
	}
}

public plugin_cfg()
{
	// AMXX only execs amxx.cfg by itself; server_exec() runs the queued commands now, so the
	// cvars are set before anything reads them. h9_presence.cfg is optional: without one a
	// dedicated server enrolls by itself.
	new dir[64], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_presence.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
	check_release();

	g_cv_mode   = get_cvar_pointer("tsm_pres_mode");
	g_cv_siege  = get_cvar_pointer("tsm_pres_siege");
	g_cv_attack = get_cvar_pointer("tsm_pres_attack");
	g_cv_prog   = get_cvar_pointer("tsm_pres_prog");

	if (!g_selftest || !url_ok())
	{
		return;
	}

	// a hand-made key: both lines in h9_presence.cfg, as presence-key.js printed them
	new server[48], key[72];
	get_pcvar_string(g_cv_server, server, charsmax(server));
	get_pcvar_string(g_cv_key, key, charsmax(key));
	trim(server);
	trim(key);
	if (server[0] || key[0])
	{
		if (!address_ok(server) || strlen(key) != 64 || !hex_ok(key))
		{
			log_amx("[PRESENCE] h9_presence_server and h9_presence_key are set but not as presence-key.js printed them -- not reporting.");
			return;
		}
		copy(g_server, charsmax(g_server), server);
		copy(g_key, charsmax(g_key), key);
		g_manual = true;
		g_estate = ES_ACTIVE;
		go_live();
		return;
	}

	// A dedicated server enrolls by itself and quietly: one that h9web cannot reach (a LAN server)
	// just stays unenrolled, asking again less and less often. A listen server (Create Game) enrolls
	// by its own player's ID proof once that player is in game (listen_enroll), from a state file of
	// its own.
	if (!get_pcvar_num(g_cv_autoenroll))
	{
		return;
	}
	if (!is_dedicated_server())
	{
		g_listen = true;
		load_state();
		if (g_estate == ES_ACTIVE)
		{
			go_live();
		}
		return;
	}
	load_state();
	if (g_estate == ES_ACTIVE)
	{
		set_pcvar_string(g_cv_enroll, "");
		go_live();
		return;
	}
	set_pcvar_string(g_cv_enroll, g_estate == ES_PROOF ? g_code : "");
	new wait = g_enext - get_systime();
	set_task(float(wait < 15 ? 15 : wait), "task_enroll", TASK_ENROLL);
}

/** Starts reporting with the live key. */
go_live()
{
	g_ready = true;
	collect_components();

	// members-only, as the last answer before this map said
	new members[4];
	get_localinfo("h9p_members", members, charsmax(members));
	g_members = members[0] == '1';

	if (get_pcvar_num(g_cv_names))
	{
		if (!get_pcvar_num(g_cv_challenge))
		{
			log_amx("[PRESENCE] h9_presence_names needs h9_presence_challenge 1: only a proven player is given a name. Names stay free.");
		}
		else
		{
			new map[64];
			get_mapname(map, charsmax(map));
			g_names = !names_free(map);
		}
	}

	new Float:every = get_pcvar_float(g_cv_interval);
	if (every < 30.0)
	{
		every = 30.0;
	}
	else if (every > 600.0)
	{
		every = 600.0;
	}
	remove_task(TASK_TICK);
	set_task(every, "task_tick", TASK_TICK, "", 0, "b");
	// players already in game (a map change) get FIRST_DELAY to prove who they are first; a server nobody is on has nothing to wait for
	soon_within(count_players() > 0 ? FIRST_DELAY : FIRST_EMPTY);

	// players already in game (a listen server that went live once its own player proved it): that
	// player's address first, then everyone's challenge
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id])
		{
			continue;
		}
		if (is_loopback(id) && can_listen(id))
		{
			client_cmd(id, "h9_idlisten %s", g_server);
		}
		challenge(id);
	}
}

/** The listen server's own player: joined over loopback, with no address. */
bool:is_loopback(id)
{
	if (is_dedicated_server())
	{
		return false;
	}
	new ip[32];
	get_user_ip(id, ip, charsmax(ip), 1);
	return equali(ip, "loopback") != 0;
}

/** A game that answers h9_idlisten (engine-h9-listen.patch): _h9idl 1 in its userinfo. */
bool:can_listen(id)
{
	new can[8];
	get_user_info(id, "_h9idl", can, charsmax(can));
	return equal(can, "1") != 0;
}

/** Whether h9_presence_url can be used. */
bool:url_ok()
{
	new url[192];
	get_pcvar_string(g_cv_url, url, charsmax(url));
	trim(url);
	// http:// only to this machine (a test site): the /enroll reply carries the server's key, and a report is signed, not secret
	return equal(url, "https://", 8) || equal(url, "http://127.0.0.1", 16) || equal(url, "http://localhost", 16);
}

/** a.b.c.d:port, digits only. */
bool:address_ok(const s[])
{
	new dots = 0, colon = 0, i;
	for (i = 0; s[i]; i++)
	{
		if (s[i] == '.')
		{
			dots++;
		}
		else if (s[i] == ':')
		{
			colon++;
		}
		else if (s[i] < '0' || s[i] > '9')
		{
			return false;
		}
	}
	return dots == 3 && colon == 1 && i >= 9 && i <= 21;
}

/** Lowercase hex only (lowercases A to F in place). */
bool:hex_ok(s[])
{
	for (new i = 0; s[i]; i++)
	{
		if (s[i] >= 'A' && s[i] <= 'F')
		{
			s[i] += 32;
		}
		if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
		{
			return false;
		}
	}
	return true;
}

// ---- players ------------------------------------------------------------------------------------

public client_putinserver(id)
{
	if (id >= 1 && id <= g_max && is_user_bot(id) && !is_user_hltv(id))
	{
		// a bot: the scoreboard shows it as one (H9Link 2), never with a chain
		g_isbot[id] = true;
		send_link(0, id, 2);
		return;
	}
	if (id < 1 || id > g_max || is_user_bot(id) || is_user_hltv(id))
	{
		return;
	}
	g_in[id] = true;
	g_gen[id]++;
	g_joined[id] = get_systime();
	forget_proof(id);
	id_info(id, g_idinfo[id], charsmax(g_idinfo[]));
	g_idchal_at[id] = 0;
	// the listen server's own player: its h9_clientid salted with this server's address first
	if (is_loopback(id))
	{
		if (g_ready && can_listen(id))
		{
			client_cmd(id, "h9_idlisten %s", g_server);
		}
		else if (g_listen && !g_ready)
		{
			listen_enroll(id);
		}
	}
	// a slot challenged a moment ago (a player reconnecting quickly) waits out CHAL_GAP
	new wait = g_chal_last[id] + CHAL_GAP - get_systime();
	if (wait > 0)
	{
		set_task(float(wait), "task_idchal", TASK_IDCHAL + id);
	}
	else
	{
		challenge(id);
	}
	soon();
	set_task(1.0, "task_avatars_to", TASK_AVATARS + id);
	// h9_require_account: a game that cannot prove an account goes at once, any other after the
	// grace period if it has not proved one by then (task_require)
	if (require_on() && !is_loopback(id))
	{
		if (!can_prove(id) && h9web_answering())
		{
			kick_with(id, REQUIRE_REASON);
			return;
		}
		set_task(float(require_grace()), "task_require", TASK_REQUIRE + id);
	}
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id >= 1 && id <= g_max && g_isbot[id])
	{
		g_isbot[id] = false;
		send_link(0, id, 0);
	}
	if (id < 1 || id > g_max || !g_in[id])
	{
		return;
	}
	g_in[id] = false;
	g_gen[id]++;
	forget_proof(id);
	remove_task(TASK_AVATARS + id);
	remove_task(TASK_REQUIRE + id);
	remove_task(TASK_IDCHAL + id);
	g_idinfo[id][0] = 0;
	g_proven[id] = false;
	if (g_av_account[id])
	{
		g_av_account[id] = 0;
		g_av_version[id] = 0;
		send_avatar(0, id, 0, 0);
	}
	if (g_linked[id])
	{
		g_linked[id] = false;
		send_link(0, id, 0);
	}
	if (g_level[id])
	{
		g_level[id] = 0;
		send_level(0, id, 255);
	}
	set_account(id, 0, "", "");
	soon();
}

public client_infochanged(id)
{
	if (id < 1 || id > g_max || !g_in[id])
	{
		return;
	}
	// another id (h9_unlink, or a REVOKE the game heard of, gives it a new one), or another word on
	// proving or linking: what the slot proved is no longer its
	new info[80];
	id_info(id, info, charsmax(info));
	if (!equal(info, g_idinfo[id]))
	{
		copy(g_idinfo[id], charsmax(g_idinfo[]), info);
		id_changed(id);
	}
	// here get_user_name still has the old name and the userinfo the new one
	new was[64], now[64];
	get_user_name(id, was, charsmax(was));
	get_user_info(id, "name", now, charsmax(now));
	if (equal(was, now))
	{
		return;
	}
	// a name h9web gave the slot on this map: put back at once
	if (g_names && g_forced[id][0] && !equal(now, g_forced[id]))
	{
		set_user_info(id, "name", g_forced[id]);
		tell(id);
		return;
	}
	soon();
}

/** The slot's h9_clientid, _h9idv and _h9lnk, as one string to compare. */
id_info(id, out[], len)
{
	new cid[40], idv[8], lnk[8];
	get_user_info(id, "h9_clientid", cid, charsmax(cid));
	get_user_info(id, "_h9idv", idv, charsmax(idv));
	get_user_info(id, "_h9lnk", lnk, charsmax(lnk));
	formatex(out, len, "%s|%s|%s", cid, idv, lnk);
}

/**
 * The slot's game has another id, or says otherwise whether it can prove or is linked: its proof
 * goes (a report answer on its way for the old one is not taken for the slot: g_gen), every client
 * hears at once that the slot is no proven account, the game is challenged again when it can prove
 * (at most once in IDCHAL_GAP seconds; a change sooner waits for the rest of them), and h9web hears
 * soon.
 */
id_changed(id)
{
	g_gen[id]++;
	forget_proof(id);
	remove_task(TASK_IDCHAL + id);
	g_proven[id] = false;
	if (g_linked[id])
	{
		g_linked[id] = false;
		send_link(0, id, 0);
	}
	if (g_av_account[id])
	{
		g_av_account[id] = 0;
		g_av_version[id] = 0;
		send_avatar(0, id, 0, 0);
	}
	set_account(id, 0, "", "");
	if (g_level[id])
	{
		g_level[id] = 0;
		send_level(0, id, 255);
	}
	new wait = g_idchal_at[id] + IDCHAL_GAP - get_systime();
	if (wait > 0)
	{
		set_task(float(wait), "task_idchal", TASK_IDCHAL + id);
	}
	else
	{
		g_idchal_at[id] = get_systime();
		challenge(id);
	}
	soon();
}

public task_idchal(task)
{
	new id = task - TASK_IDCHAL;
	if (id >= 1 && id <= g_max && g_in[id])
	{
		g_idchal_at[id] = get_systime();
		challenge(id);
	}
}

forget_proof(id)
{
	g_nonce[id][0] = 0;
	g_pnonce[id][0] = 0;
	g_fetching[id] = false;
	g_devmask[id][0] = 0;
	g_proof[id][0] = 0;
	g_asked[id] = 0;
	g_forced[id][0] = 0;
	g_neutral[id] = false;
	g_muted[id] = false;
}

// ---- the challenge ------------------------------------------------------------------------------

/**
 * Asks h9web for a nonce for a client that says it can answer (_h9idv 1 in its userinfo), and
 * sends it as the challenge (on_nonce). Only an answer to the slot's own nonce is reported
 * (cmd_idproof); the slot's last proof stays in the reports until then.
 */
challenge(id)
{
	if (!g_ready || !(get_pcvar_num(g_cv_challenge) || get_pcvar_num(g_cv_require) == 1) || g_fetching[id])
	{
		return;
	}
	new can[8];
	get_user_info(id, "_h9idv", can, charsmax(can));
	if (!equal(can, "1"))
	{
		return;
	}
	// over loopback the proof must sign this server's address, which only h9_idlisten does
	if (is_loopback(id) && !can_listen(id))
	{
		return;
	}
	new url[200], body[192], sig[65], nonce[17];
	api_url(url, charsmax(url), "/server/nonce");
	make_nonce(nonce);
	formatex(body, charsmax(body), "{^"v^":1,^"server^":^"%s^",^"ts^":%d,^"nonce^":^"%s^",^"count^":1}", g_server, get_systime(), nonce);
	hmac_sha256(g_key, strlen(g_key), body, strlen(body), sig, charsmax(sig));
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.5");
	ezhttp_option_set_timeout(opt, 8000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	new ud[2];
	ud[0] = id;
	ud[1] = g_gen[id];
	ezhttp_option_set_user_data(opt, ud, sizeof(ud));
	g_fetching[id] = true;
	g_asked[id] = get_systime();
	g_chal_last[id] = g_asked[id];
	ezhttp_post(url, "on_nonce", opt);
}

public on_nonce(EzHttpRequest:request_id)
{
	new ud[2];
	ezhttp_get_user_data(request_id, ud);
	new id = ud[0];
	if (id < 1 || id > g_max)
	{
		return;
	}
	g_fetching[id] = false;
	if (!g_in[id] || ud[1] != g_gen[id] || ezhttp_get_error_code(request_id) != EZH_OK || ezhttp_get_http_code(request_id) != 200)
	{
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		return;
	}
	new nonce[40];
	nonce[0] = 0;
	new EzJSON:list = ezjson_object_get_value(root, "nonces");
	if (list != EzInvalid_JSON)
	{
		if (ezjson_get_type(list) == EzJSONArray && ezjson_array_get_count(list) > 0)
		{
			ezjson_array_get_string(list, 0, nonce, charsmax(nonce));
		}
		ezjson_free(list);
	}
	ezjson_free(root);
	if (strlen(nonce) != 32 || !hex_ok(nonce))
	{
		return;
	}
	copy(g_nonce[id], charsmax(g_nonce[]), nonce);
	g_asked[id] = get_systime();
	if (is_loopback(id))
	{
		client_cmd(id, "h9_idlisten %s %s", g_server, g_nonce[id]);
	}
	else
	{
		client_cmd(id, "h9_idchallenge %s", g_nonce[id]);
	}
}

random32()
{
	return (random_num(0, 0xFFFF) << 16) | random_num(0, 0xFFFF);
}

/** Eight lowercase hex characters of value at out[pos]. */
hex32(value, out[], pos)
{
	for (new k = 7; k >= 0; k--)
	{
		out[pos + k] = HEX[value & 15];
		value = value >>> 4;
	}
}

/**
 * The client's answer: h9_idproof <nonce> <devmask> <proof>. Every well-formed one goes to the
 * h9p_proof forward; the one to this slot's own challenge goes into the reports.
 */
public cmd_idproof(id, level, cid)
{
	if (id < 1 || id > g_max || !g_in[id])
	{
		return PLUGIN_HANDLED;
	}
	new nonce[40], devmask[40], proof[72];
	read_argv(1, nonce, charsmax(nonce));
	read_argv(2, devmask, charsmax(devmask));
	read_argv(3, proof, charsmax(proof));
	if (strlen(nonce) != 32 || strlen(devmask) != 32 || strlen(proof) != 64 || !hex_ok(nonce) || !hex_ok(devmask) || !hex_ok(proof))
	{
		return PLUGIN_HANDLED;
	}
	new ret;
	ExecuteForward(g_fwd_proof, ret, id, nonce, devmask, proof);
	// the listen server's own player proving this address for its enrollment
	if (g_listen && g_estate == ES_PROOF && id == g_lhost && g_gen[id] == g_lgen && g_lnonce[0] && equal(nonce, g_lnonce))
	{
		g_lnonce[0] = 0;
		send_listen_proof(id, nonce, devmask, proof);
		return PLUGIN_HANDLED;
	}
	if (!g_nonce[id][0] || !equal(nonce, g_nonce[id]))
	{
		return PLUGIN_HANDLED;
	}
	copy(g_pnonce[id], charsmax(g_pnonce[]), nonce);
	copy(g_devmask[id], charsmax(g_devmask[]), devmask);
	copy(g_proof[id], charsmax(g_proof[]), proof);
	g_nonce[id][0] = 0;
	// reported at once: the chain, the picture and the level come with h9web's answer
	soon_within(PROOF_REPORT);
	return PLUGIN_HANDLED;
}

// ---- when to report -----------------------------------------------------------------------------

soon()
{
	soon_within(REPORT_DELAY);
}

/**
 * A report within delay seconds: the one already waiting if it goes sooner, else this one in its
 * place, but never sooner than FAST_GAP seconds after the last report went.
 */
soon_within(Float:delay)
{
	if (!g_ready)
	{
		return;
	}
	new Float:now = get_gametime();
	new Float:due = now + delay;
	if (due < g_report_at + FAST_GAP)
	{
		due = g_report_at + FAST_GAP;
	}
	if (task_exists(TASK_SOON) && g_soon_due <= due)
	{
		return;
	}
	remove_task(TASK_SOON);
	g_soon_due = due;
	set_task(due - now > 0.1 ? due - now : 0.1, "task_soon", TASK_SOON);
}

public task_soon()
{
	g_soon_due = 0.0;
	send_report("event");
}

public task_tick()
{
	// every proof is asked for again before h9web's 10 minutes run out
	new now = get_systime();
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id] && g_asked[id] && now - g_asked[id] > RECHALLENGE)
		{
			challenge(id);
		}
		// h9_require_account switched on while they were in: they get the grace period from now
		if (g_in[id] && require_on() && !player_proven(id) && !is_loopback(id) && !task_exists(TASK_REQUIRE + id))
		{
			if (!g_asked[id])
			{
				challenge(id);
			}
			set_task(float(require_grace()), "task_require", TASK_REQUIRE + id);
		}
	}
	// what the server runs goes again every COMP_EVERY seconds, so a list h9web lost is not lost for long
	if (!g_comp_due && now - g_comp_at > COMP_EVERY)
	{
		g_comp_due = true;
	}
	// every tick reports, a server with nobody on it too: h9web calls a server that has not reported for
	// authFreshSeconds one that does not report, and the chain beside it goes red
	send_report("tick");
}

count_players()
{
	new n = 0, cid[40];
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id] && is_user_connected(id) && get_user_info(id, "h9_clientid", cid, charsmax(cid)) && cid[0])
		{
			n++;
		}
	}
	return n;
}

// ---- the report ---------------------------------------------------------------------------------

send_report(const reason[])
{
	if (!g_ready)
	{
		return;
	}
	if (g_sending)
	{
		g_again = true;
		return;
	}
	if (g_backoff_until && get_systime() < g_backoff_until)
	{
		return;
	}
	if (!g_key[0] || !url_ok())
	{
		return;
	}
	new url[200];
	api_url(url, charsmax(url), "/report");

	new count = build_report(reason, g_server);
	new sig[65];
	hmac_sha256(g_key, strlen(g_key), g_body, g_len, sig, charsmax(sig));

	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.5");
	ezhttp_option_set_timeout(opt, 8000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, g_body);

	g_sending = true;
	g_sent_count = count;
	g_report_at = get_gametime();
	ezhttp_post(url, "on_report_done", opt);
}

public on_report_done(EzHttpRequest:request_id)
{
	new bool:carried = g_comp_sent;
	g_comp_sent = false;
	g_sending = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		new err[128];
		ezhttp_get_error_message(request_id, err, charsmax(err));
		note_result(-1, err);
	}
	else
	{
		new status = ezhttp_get_http_code(request_id);
		if (status == 200)
		{
			if (carried)
			{
				g_comp_due = false;
				g_comp_at = get_systime();
			}
			g_last_count = g_sent_count;
			g_accepted++;
			g_bad = 0;
			g_answered_at = get_systime();
			note_result(200, "");
			new EzJSON:root = ezhttp_parse_json_response(request_id);
			if (root != EzInvalid_JSON)
			{
				apply_actions(root);
				apply_avatars(root);
				apply_accounts(root);
				apply_levels(root);
				apply_host(root);
				apply_proven(root);
				if (g_names)
				{
					apply_names(root);
				}
				// members-only servers: once h9web says so, the next report lists everyone
				new bool:members = ezjson_object_has_value(root, "members", EzJSONBoolean) && ezjson_object_get_bool(root, "members");
				if (members != g_members)
				{
					g_members = members;
					set_localinfo("h9p_members", members ? "1" : "0");
					if (members)
					{
						g_again = true;
					}
				}
				ezjson_free(root);
			}
		}
		else
		{
			// h9web's answer is { "error": code, "message": text }: no secret in it
			new answer[200];
			ezhttp_get_data(request_id, answer, charsmax(answer));
			note_result(status, answer);
			if (status == 429 || status == 503)
			{
				g_backoff_until = get_systime() + 60;
			}
			if (!g_manual && (status == 401 || status == 403))
			{
				key_refused(answer);
			}
		}
	}
	if (g_again)
	{
		// what changed while it was in flight (a proof among it) goes in the next, as soon as it may
		g_again = false;
		soon_within(PROOF_REPORT);
	}
}

/** Logs an outcome when it differs from the last one, so a lasting problem is one line, not one a minute. */
note_result(status, const text[])
{
	if (status == g_last_status)
	{
		return;
	}
	g_last_status = status;
	if (status == 200)
	{
		log_amx("[PRESENCE] h9web accepts this server's reports.");
	}
	else if (status == -1)
	{
		log_amx("[PRESENCE] Could not reach h9web: %s", text);
	}
	else
	{
		log_amx("[PRESENCE] h9web refused the report: HTTP %d %s", status, text);
	}
}

/**
 * Builds the report into g_body and returns how many players are in it. A player whose
 * h9_clientid appears twice is left out both times (h9web would drop both anyway), and a player
 * challenged a moment ago is left out until the answer comes or PROOF_WAIT runs out.
 */
build_report(const reason[], const server[])
{
	new map[64], key[32], siege[16], attack[8], prog[32], mode[48], detail[128];
	get_mapname(map, charsmax(map));
	pres(g_cv_mode, key, charsmax(key));
	pres(g_cv_siege, siege, charsmax(siege));
	pres(g_cv_attack, attack, charsmax(attack));
	pres(g_cv_prog, prog, charsmax(prog));
	mode_name(map, key, siege, mode, charsmax(mode));
	detail_line(mode, key, siege, attack, prog, detail, charsmax(detail));

	// a report's ts must be later than the last one h9web took from this server
	new ts = get_systime();
	if (ts <= g_last_ts)
	{
		ts = g_last_ts + 1;
	}
	g_last_ts = ts;

	g_len = 0;
	g_body[0] = 0;
	app_raw("{^"v^":1,^"server^":");
	app_str(server);
	app_raw(",^"ts^":");
	app_num(ts);
	app_raw(",^"reason^":");
	app_str(reason);
	app_raw(",^"map^":");
	app_str(map);
	app_raw(",^"mode^":");
	app_str(mode);
	if (!equal(detail, mode))
	{
		app_raw(",^"detail^":");
		app_str(detail);
	}
	new host[64], list[MAX_PLAYERS], humans;
	get_cvar_string("hostname", host, charsmax(host));
	get_players(list, humans, "ch");
	app_raw(",^"name^":");
	app_str(host);
	app_raw(",^"humans^":");
	app_num(humans);
	app_raw(",^"max^":");
	app_num(g_max);
	// a listen server's own player, so h9web says how it knows that player (apply_host)
	for (new h = 1; h <= g_max; h++)
	{
		if (g_in[h] && is_loopback(h))
		{
			app_raw(",^"host^":");
			app_num(h);
			break;
		}
	}
	if (g_names)
	{
		app_raw(",^"names^":true");
	}
	g_auth_flight = get_pcvar_num(g_cv_auth) != 0;
	if (!g_auth_flight)
	{
		app_raw(",^"authenticated^":false");
	}
	if (g_comp_due && g_comp_n > 0)
	{
		app_components();
		g_comp_sent = true;
	}
	app_raw(",^"players^":[");

	new n = 0, now = get_systime();
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || !is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
		{
			continue;
		}
		if ((g_nonce[id][0] || g_fetching[id]) && !g_proof[id][0] && now - g_asked[id] < PROOF_WAIT)
		{
			continue;
		}
		get_user_info(id, "h9_clientid", g_ids[n], charsmax(g_ids[]));
		g_hasid[n] = strlen(g_ids[n]) == 32 && hex_ok(g_ids[n]);
		if (!g_hasid[n] && !g_names && !g_members)
		{
			continue;
		}
		g_who[n] = id;
		g_sent_gen[id] = g_gen[id];
		n++;
	}

	// with names on, a player without a usable h9_clientid goes in by slot and name alone, for
	// h9web's check that the name is not an account's; on a members-only server too, to be turned away
	new sent = 0;
	g_left_out = 0;
	for (new i = 0; i < n; i++)
	{
		new bool:full = g_hasid[i] && !listed_twice(i, n);
		if (!full && !g_names && !g_members)
		{
			continue;
		}
		if (g_len > MAX_BODY - ROOM_PER_PLAYER)
		{
			g_left_out++;
			continue;
		}
		if (sent)
		{
			app_byte(',');
		}
		if (full)
		{
			app_player(g_who[i], g_ids[i]);
		}
		else
		{
			app_name_only(g_who[i]);
		}
		sent++;
	}
	app_raw("]}");
	if (g_left_out)
	{
		log_amx("[PRESENCE] The report was full: %d player(s) left out of it.", g_left_out);
	}
	return sent;
}

/**
 * Lists what this server runs, once a map (go_live): the AMX Mod X plugins that loaded (not one that
 * failed to), the modules in the modules folder, and the Metamod plugins plugins.ini names that exist,
 * each with the SHA-256 of its file. hash_file raises an error for a file it cannot open, so a file is
 * looked for first and a missing one is not listed.
 */
collect_components()
{
	g_comp_n = 0;
	g_comp_due = true;
	new dir[96], path[200], file[96], name[2], version[32], author[2], status[24];

	get_localinfo("amxx_pluginsdir", dir, charsmax(dir));
	if (!dir[0])
	{
		copy(dir, charsmax(dir), "addons/amxmodx/plugins");
	}
	new total = get_pluginsnum();
	for (new i = 0; i < total; i++)
	{
		if (get_plugin(i, file, charsmax(file), name, charsmax(name), version, charsmax(version), author, charsmax(author), status, charsmax(status)) < 0)
		{
			continue;
		}
		if (equali(status, "bad load"))
		{
			continue;
		}
		formatex(path, charsmax(path), "%s/%s", dir, file);
		add_component(0, file, version, path);
	}

	get_localinfo("amxx_modulesdir", dir, charsmax(dir));
	if (!dir[0])
	{
		copy(dir, charsmax(dir), "addons/amxmodx/modules");
	}
	new FileType:type;
	new handle = open_dir(dir, file, charsmax(file), type);
	if (handle)
	{
		do
		{
			if (type == FileType_File && (ends_with(file, "_amxx.dll") || ends_with(file, "_amxx.so") || ends_with(file, "_amxx_i386.so")))
			{
				formatex(path, charsmax(path), "%s/%s", dir, file);
				add_component(1, file, "", path);
			}
		}
		while (next_file(handle, file, charsmax(file), type));
		close_dir(handle);
	}

	// Metamod: "win32 addons/amxmodx/dlls/amxmodx_mm.dll", a path from the game's folder; the file is listed by its name
	new f = fopen("addons/metamod/plugins.ini", "rt");
	if (f)
	{
		new line[200], os[16], rest[180];
		while (!feof(f))
		{
			fgets(f, line, charsmax(line));
			new cut = contain(line, ";");
			if (cut >= 0)
			{
				line[cut] = 0;
			}
			trim(line);
			if (!line[0])
			{
				continue;
			}
			parse(line, os, charsmax(os), rest, charsmax(rest));
			if (!rest[0] || !(equali(os, "win32") || equali(os, "linux")))
			{
				continue;
			}
			new last = -1;
			for (new c = 0; rest[c]; c++)
			{
				if (rest[c] == 47 || rest[c] == 92)
				{
					last = c;
				}
			}
			add_component(2, rest[last + 1], "", rest);
		}
		fclose(f);
	}
}

/** One file of the list: its kind, name, version and SHA-256; a file that is not there is left out. */
add_component(kind, const file[], const version[], const path[])
{
	if (g_comp_n >= COMP_MAX || !file[0] || file_size(path) < 0)
	{
		return;
	}
	new n = g_comp_n;
	g_comp_kind[n] = kind;
	copy(g_comp_file[n], charsmax(g_comp_file[]), file);
	copy(g_comp_ver[n], charsmax(g_comp_ver[]), version);
	g_comp_hash[n][0] = 0;
	hash_file(path, Hash_Sha256, g_comp_hash[n], charsmax(g_comp_hash[]));
	g_comp_n++;
}

bool:ends_with(const text[], const tail[])
{
	new lt = strlen(text), ltail = strlen(tail);
	return lt >= ltail && equali(text[lt - ltail], tail);
}

/** The list, as the report's plugins array: h9web's preset.js reads k (kind), f (file), v (version) and h (SHA-256). */
app_components()
{
	app_raw(",^"plugins^":[");
	for (new i = 0; i < g_comp_n; i++)
	{
		if (i)
		{
			app_byte(',');
		}
		app_raw("{^"k^":");
		app_str(COMP_KIND[g_comp_kind[i]]);
		app_raw(",^"f^":");
		app_str(g_comp_file[i]);
		if (g_comp_ver[i][0])
		{
			app_raw(",^"v^":");
			app_str(g_comp_ver[i]);
		}
		app_raw(",^"h^":");
		app_str(g_comp_hash[i]);
		app_byte('}');
	}
	app_byte(']');
}

bool:listed_twice(i, n)
{
	for (new j = 0; j < n; j++)
	{
		if (j != i && g_hasid[j] && equal(g_ids[i], g_ids[j]))
		{
			return true;
		}
	}
	return false;
}

app_player(id, const cid[])
{
	new name[64], net[48];
	get_user_name(id, name, charsmax(name));
	app_raw("{^"id^":");
	app_str(cid);
	app_raw(",^"slot^":");
	app_num(id);
	app_raw(",^"name^":");
	app_str(name);
	app_raw(",^"joined^":");
	app_num(g_joined[id]);
	app_raw(",^"time^":");
	app_num(get_user_time(id, 1));
	if (g_proof[id][0])
	{
		app_raw(",^"nonce^":");
		app_str(g_pnonce[id]);
		app_raw(",^"devmask^":");
		app_str(g_devmask[id]);
		app_raw(",^"proof^":");
		app_str(g_proof[id]);
		if (coarse_net(id, net, charsmax(net)))
		{
			app_raw(",^"net^":");
			app_str(net);
		}
	}
	app_byte('}');
}

app_name_only(id)
{
	new name[64];
	get_user_name(id, name, charsmax(name));
	app_raw("{^"slot^":");
	app_num(id);
	app_raw(",^"name^":");
	app_str(name);
	app_byte('}');
}

/**
 * The player's network, coarse: an IPv4 address cut to its /24 ("203.0.113"), an IPv6 one to its
 * first three groups (/48). Only sent with a proof; h9web keeps nothing but a keyed hash of it.
 */
bool:coarse_net(id, out[], len)
{
	new ip[64];
	get_user_ip(id, ip, charsmax(ip), 1);
	new cut = 0, seen = 0, i;
	new bool:v6 = contain(ip, ":") >= 0;
	for (i = 0; ip[i] && i < len; i++)
	{
		if (ip[i] == (v6 ? ':' : '.'))
		{
			seen++;
			if (seen == 3)
			{
				break;
			}
		}
		if (!((ip[i] >= '0' && ip[i] <= '9') || (ip[i] >= 'a' && ip[i] <= 'f') || (ip[i] >= 'A' && ip[i] <= 'F') || ip[i] == '.' || ip[i] == ':'))
		{
			return false;
		}
		out[cut++] = ip[i];
	}
	out[cut] = 0;
	return seen == 3 && cut > 0;
}

// ---- enrollment ---------------------------------------------------------------------------------

/** h9_presence_url without its /report, and path after it. */
api_url(out[], len, const path[])
{
	new url[192];
	get_pcvar_string(g_cv_url, url, charsmax(url));
	trim(url);
	new n = strlen(url);
	if (n > 7 && equal(url[n - 7], "/report"))
	{
		url[n - 7] = 0;
	}
	formatex(out, len, "%s%s", url, path);
}

state_path(out[], len)
{
	new dir[64];
	get_datadir(dir, charsmax(dir));
	if (g_listen)
	{
		formatex(out, len, "%s/h9_presence_listen.key", dir);
	}
	else
	{
		formatex(out, len, "%s/h9_presence.key", dir);
	}
}

load_state()
{
	new path[128], line[192], name[16], value[160];
	state_path(path, charsmax(path));
	new f = fopen(path, "rt");
	if (!f)
	{
		return;
	}
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		trim(line);
		if (!line[0] || line[0] == '/')
		{
			continue;
		}
		split(line, name, charsmax(name), value, charsmax(value), "=");
		trim(name);
		trim(value);
		if (equal(name, "address"))
		{
			copy(g_server, charsmax(g_server), value);
		}
		else if (equal(name, "key"))
		{
			copy(g_key, charsmax(g_key), value);
		}
		else if (equal(name, "code"))
		{
			copy(g_code, charsmax(g_code), value);
		}
		else if (equal(name, "serverid"))
		{
			copy(g_serverid, charsmax(g_serverid), value);
		}
		else if (equal(name, "state"))
		{
			g_estate = str_to_num(value);
		}
		else if (equal(name, "next"))
		{
			g_enext = str_to_num(value);
		}
		else if (equal(name, "tries"))
		{
			g_etries = str_to_num(value);
		}
	}
	fclose(f);
	if (!address_ok(g_server) || strlen(g_key) != 64 || !hex_ok(g_key) || g_estate < ES_NONE || g_estate > ES_ACTIVE)
	{
		g_key[0] = 0;
		g_code[0] = 0;
		g_estate = ES_NONE;
	}
}

save_state()
{
	new path[128];
	state_path(path, charsmax(path));
	new f = fopen(path, "wt");
	if (!f)
	{
		return;
	}
	fputs(f, "// h9_presence: this server's enrollment with havoc9.org (docs/H9_PRESENCE.txt).^n");
	fputs(f, "// THE KEY IS A SECRET: whoever has it can report players onto this server. Never share or commit^n");
	fputs(f, "// this file; client packages leave *.key files out. Delete it to make the server enroll again.^n");
	fprintf(f, "address=%s^nkey=%s^ncode=%s^nserverid=%s^n", g_server, g_key, g_code, g_serverid);
	fprintf(f, "state=%d^nnext=%d^ntries=%d^n", g_estate, g_enext, g_etries);
	fclose(f);
}

forget_key()
{
	g_key[0] = 0;
	g_code[0] = 0;
	g_estate = ES_NONE;
	set_pcvar_string(g_cv_enroll, "");
}

schedule_enroll(seconds)
{
	g_enext = get_systime() + seconds;
	save_state();
	remove_task(TASK_ENROLL);
	set_task(float(seconds), "task_enroll", TASK_ENROLL);
}

/** The next enrollment step after a failure or a wait: further off each time, 10 seconds to 6 hours. */
wait_more()
{
	new i = g_etries < sizeof(BACKOFF) ? g_etries : sizeof(BACKOFF) - 1;
	g_etries++;
	schedule_enroll(BACKOFF[i]);
}

public task_enroll()
{
	if (g_ebusy || g_estate == ES_ACTIVE)
	{
		return;
	}
	if (g_listen)
	{
		// a listen server enrolls afresh each time, with its own player still in game
		if (g_lhost && g_in[g_lhost] && g_gen[g_lhost] == g_lgen)
		{
			forget_key();
			send_enroll();
		}
		return;
	}
	if (g_estate == ES_NONE || !g_key[0])
	{
		send_enroll();
	}
	else
	{
		send_enroll_status();
	}
}

/** Asks h9web for a key for this server's own address (the caller's IP and this port). */
send_enroll()
{
	new port = get_cvar_num("hostport");
	if (port <= 0)
	{
		port = get_cvar_num("port");
	}
	if (port <= 0)
	{
		port = 27015;
	}
	new url[200], body[64];
	api_url(url, charsmax(url), "/enroll");
	if (g_listen)
	{
		formatex(body, charsmax(body), "{^"v^":1,^"port^":%d,^"listen^":true}", port);
	}
	else
	{
		formatex(body, charsmax(body), "{^"v^":1,^"port^":%d}", port);
	}
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_user_agent(opt, "h9_presence/1.5");
	ezhttp_option_set_timeout(opt, 8000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	g_ebusy = true;
	ezhttp_post(url, "on_enroll", opt);
}

public on_enroll(EzHttpRequest:request_id)
{
	g_ebusy = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK || ezhttp_get_http_code(request_id) != 200)
	{
		wait_more();
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		wait_more();
		return;
	}
	new key[72], code[24], server[48], sid[16], lnonce[40];
	if (g_listen && ezjson_object_has_value(root, "nonce", EzJSONString))
	{
		ezjson_object_get_string(root, "nonce", lnonce, charsmax(lnonce));
	}
	if (ezjson_object_has_value(root, "key", EzJSONString))
	{
		ezjson_object_get_string(root, "key", key, charsmax(key));
	}
	if (ezjson_object_has_value(root, "code", EzJSONString))
	{
		ezjson_object_get_string(root, "code", code, charsmax(code));
	}
	if (ezjson_object_has_value(root, "server", EzJSONString))
	{
		ezjson_object_get_string(root, "server", server, charsmax(server));
	}
	if (ezjson_object_has_value(root, "serverId", EzJSONString))
	{
		ezjson_object_get_string(root, "serverId", sid, charsmax(sid));
	}
	ezjson_free(root);
	if (strlen(key) != 64 || !hex_ok(key) || !address_ok(server) || strlen(code) < 8)
	{
		wait_more();
		return;
	}
	copy(g_key, charsmax(g_key), key);
	copy(g_code, charsmax(g_code), code);
	copy(g_server, charsmax(g_server), server);
	copy(g_serverid, charsmax(g_serverid), sid);
	g_estate = ES_PROOF;
	g_etries = 0;
	if (g_listen)
	{
		// the proof comes from this server's own player, over loopback (cmd_idproof); no answer
		// within a minute and it starts again, later
		if (strlen(lnonce) != 32 || !hex_ok(lnonce) || !g_lhost || !g_in[g_lhost] || g_gen[g_lhost] != g_lgen)
		{
			forget_key();
			wait_more();
			return;
		}
		copy(g_lnonce, charsmax(g_lnonce), lnonce);
		client_cmd(g_lhost, "h9_idlisten %s %s", g_server, g_lnonce);
		schedule_enroll(60);
		return;
	}
	set_pcvar_string(g_cv_enroll, g_code);
	schedule_enroll(5);
}

/**
 * A listen server's enrollment: h9web gives a key and a nonce for this address, the server's own
 * player answers the nonce over loopback (h9_idlisten), and that proof makes the key live
 * (send_listen_proof).
 */
listen_enroll(id)
{
	if (g_ebusy || g_estate == ES_ACTIVE || !g_selftest || !url_ok())
	{
		return;
	}
	if (!can_listen(id))
	{
		log_amx("[PRESENCE] Not reporting: this listen server's own player's game does not answer h9_idlisten (H9XASH from 2026-11-02 on does).");
		return;
	}
	g_lhost = id;
	g_lgen = g_gen[id];
	forget_key();
	send_enroll();
}

/** The listen server's own player's proof for this address, in the enrollment's status call. */
send_listen_proof(id, const nonce[], const devmask[], const proof[])
{
	new cid[40];
	get_user_info(id, "h9_clientid", cid, charsmax(cid));
	if (strlen(cid) != 32 || !hex_ok(cid))
	{
		forget_key();
		wait_more();
		return;
	}
	new url[200], body[400], sig[65], n[17];
	api_url(url, charsmax(url), "/enroll/status");
	make_nonce(n);
	formatex(body, charsmax(body), "{^"v^":1,^"server^":^"%s^",^"ts^":%d,^"nonce^":^"%s^",^"host^":{^"id^":^"%s^",^"nonce^":^"%s^",^"devmask^":^"%s^",^"proof^":^"%s^"}}", g_server, get_systime(), n, cid, nonce, devmask, proof);
	hmac_sha256(g_key, strlen(g_key), body, strlen(body), sig, charsmax(sig));
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.5");
	ezhttp_option_set_timeout(opt, 12000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	g_ebusy = true;
	remove_task(TASK_ENROLL);
	ezhttp_post(url, "on_enroll_status", opt);
}

/** Asks whether h9web has seen the code (and checks again when it is time). */
send_enroll_status()
{
	new url[200], body[192], sig[65], nonce[17];
	api_url(url, charsmax(url), "/enroll/status");
	make_nonce(nonce);
	formatex(body, charsmax(body), "{^"v^":1,^"server^":^"%s^",^"ts^":%d,^"nonce^":^"%s^"}", g_server, get_systime(), nonce);
	hmac_sha256(g_key, strlen(g_key), body, strlen(body), sig, charsmax(sig));
	new EzHttpOptions:opt = ezhttp_create_options();
	ezhttp_option_set_header(opt, "Content-Type", "application/json");
	ezhttp_option_set_header(opt, "X-H9-Server", g_server);
	ezhttp_option_set_header(opt, "X-H9-Signature", sig);
	ezhttp_option_set_user_agent(opt, "h9_presence/1.5");
	ezhttp_option_set_timeout(opt, 12000);
	ezhttp_option_set_connect_timeout(opt, 5000);
	ezhttp_option_set_body(opt, body);
	g_ebusy = true;
	ezhttp_post(url, "on_enroll_status", opt);
}

public on_enroll_status(EzHttpRequest:request_id)
{
	g_ebusy = false;
	if (ezhttp_get_error_code(request_id) != EZH_OK)
	{
		wait_more();
		return;
	}
	new code = ezhttp_get_http_code(request_id);
	if (code == 401 || code == 403)
	{
		// the enrollment is gone (unproven for an hour, or revoked): start again, later
		forget_key();
		wait_more();
		return;
	}
	if (code != 200)
	{
		wait_more();
		return;
	}
	new EzJSON:root = ezhttp_parse_json_response(request_id);
	if (root == EzInvalid_JSON)
	{
		wait_more();
		return;
	}
	new status[24], sid[16];
	if (ezjson_object_has_value(root, "status", EzJSONString))
	{
		ezjson_object_get_string(root, "status", status, charsmax(status));
	}
	if (ezjson_object_has_value(root, "serverId", EzJSONString))
	{
		ezjson_object_get_string(root, "serverId", sid, charsmax(sid));
		if (sid[0])
		{
			copy(g_serverid, charsmax(g_serverid), sid);
		}
	}
	ezjson_free(root);
	if (equal(status, "active"))
	{
		g_estate = ES_ACTIVE;
		g_etries = 0;
		g_code[0] = 0;
		set_pcvar_string(g_cv_enroll, "");
		save_state();
		log_amx("[PRESENCE] Enrolled with havoc9.org as server %s; reporting.", g_serverid);
		if (!g_ready)
		{
			go_live();
		}
	}
	else if (equal(status, "pending_approval"))
	{
		if (g_estate != ES_APPROVAL)
		{
			log_amx("[PRESENCE] Enrolled with havoc9.org as server %s; an H9 admin approves it before it reports.", g_serverid);
		}
		g_estate = ES_APPROVAL;
		g_etries = 0;
		g_code[0] = 0;
		set_pcvar_string(g_cv_enroll, "");
		schedule_enroll(600);
	}
	else if (equal(status, "blocked"))
	{
		forget_key();
		g_etries = sizeof(BACKOFF) - 1;
		wait_more();
	}
	else
	{
		// not seen yet: a LAN or firewalled server stays here, quietly, asking less and less often
		wait_more();
	}
}

/** Three refused reports in a row with an enrolled key: waiting for approval again, or the key is gone. */
key_refused(const answer[])
{
	if (++g_bad < 3)
	{
		return;
	}
	g_bad = 0;
	g_ready = false;
	remove_task(TASK_TICK);
	g_etries = 0;
	if (contain(answer, "pending_approval") >= 0)
	{
		g_estate = ES_APPROVAL;
		schedule_enroll(600);
	}
	else
	{
		forget_key();
		schedule_enroll(30);
	}
}

make_nonce(out[17])
{
	hex32(random32(), out, 0);
	hex32(random32(), out, 8);
	out[16] = 0;
}

// ---- what h9web says to do with each player ----------------------------------------------------

/** The answer's actions: kick a banned account or a one-off kick, and who is muted. */
apply_actions(EzJSON:root)
{
	new key[32], reason[160];
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "actions.%d.kick", id);
		if (ezjson_object_has_value(root, key, EzJSONString, true))
		{
			ezjson_object_get_string(root, key, reason, charsmax(reason), true);
			kick_with(id, reason);
			continue;
		}
		formatex(key, charsmax(key), "actions.%d.mute", id);
		g_muted[id] = ezjson_object_has_value(root, key, EzJSONBoolean, true) && ezjson_object_get_bool(root, key, true);
	}
}

/** Kicks the slot's player with a reason, cleaned for the server command (the answer's kicks, h9_require_account). */
kick_with(id, const why[])
{
	new reason[160];
	copy(reason, charsmax(reason), why);
	clean_reason(reason);
	server_cmd("kick #%d ^"%s^"", get_user_userid(id), reason);
}

/** h9_require_account 1, on a server that reports (with no key it cannot check anyone: it fails open). */
bool:require_on()
{
	return g_ready && get_pcvar_num(g_cv_require) == 1;
}

/** The grace period, 10 to 300 seconds. */
require_grace()
{
	new g = get_pcvar_num(g_cv_require_grace);
	return g < 10 ? 10 : g > 300 ? 300 : g;
}

/** h9web took a report within two report intervals: the requirement is kept; else it fails open. */
bool:h9web_answering()
{
	new every = floatround(get_pcvar_float(g_cv_interval));
	if (every < 30)
	{
		every = 30;
	}
	else if (every > 600)
	{
		every = 600;
	}
	return g_answered_at > 0 && get_systime() - g_answered_at <= 2 * every + 30;
}

/** A game that can prove a havoc9.org account: _h9idv 1 and an h9_clientid of 32 hex characters. */
bool:can_prove(id)
{
	new can[8], cid[40];
	get_user_info(id, "_h9idv", can, charsmax(can));
	get_user_info(id, "h9_clientid", cid, charsmax(cid));
	return equal(can, "1") != 0 && strlen(cid) == 32 && hex_ok(cid);
}

/** h9web's last answer counted the slot as a proven account (its "proven", or a picture named for it). */
bool:player_proven(id)
{
	return g_proven[id] || g_linked[id];
}

/** The answer's "proven": the slots of this report that proved a havoc9.org account. */
apply_proven(EzJSON:root)
{
	new EzJSON:list = ezjson_object_get_value(root, "proven");
	if (list == EzInvalid_JSON)
	{
		return;
	}
	if (ezjson_get_type(list) == EzJSONArray)
	{
		for (new id = 1; id <= g_max; id++)
		{
			if (g_in[id] && g_sent_gen[id] == g_gen[id])
			{
				g_proven[id] = false;
			}
		}
		new n = ezjson_array_get_count(list);
		for (new i = 0; i < n; i++)
		{
			new slot = ezjson_array_get_number(list, i);
			if (slot >= 1 && slot <= g_max && g_in[slot] && g_sent_gen[slot] == g_gen[slot])
			{
				g_proven[slot] = true;
			}
		}
	}
	ezjson_free(list);
}

/**
 * h9_require_account's check, the grace period after a join: a player with no proven account is
 * kicked. While h9web is not answering, and while it has given the player no challenge, it fails
 * open and looks again a grace period later.
 */
public task_require(task)
{
	new id = task - TASK_REQUIRE;
	if (id < 1 || id > g_max || !g_in[id] || !require_on() || player_proven(id) || is_loopback(id))
	{
		return;
	}
	if (!h9web_answering() || (can_prove(id) && !g_nonce[id][0] && !g_pnonce[id][0]))
	{
		set_task(float(require_grace()), "task_require", TASK_REQUIRE + id);
		return;
	}
	kick_with(id, REQUIRE_REASON);
}

/** A reason as it may go into a server command: letters, digits, space and . , : ! ? ( ) - / = only. */
clean_reason(s[])
{
	new j = 0;
	for (new i = 0; s[i]; i++)
	{
		new c = s[i];
		if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == ' ' || c == '.' || c == ',' || c == ':' || c == '!' || c == '?' || c == '(' || c == ')' || c == '-' || c == '/' || c == '=')
		{
			s[j] = c;
			j++;
		}
	}
	s[j] = 0;
	if (!s[0])
	{
		copy(s, 8, "Removed");
	}
}

/** A muted account's chat goes nowhere, here or to the community. */
public hook_say(id)
{
	if (id < 1 || id > g_max || !g_muted[id])
	{
		return PLUGIN_CONTINUE;
	}
	new now = get_systime();
	if (now - g_mute_told[id] >= 5)
	{
		g_mute_told[id] = now;
		client_print(id, print_chat, "[H9] You are muted on this server's community.");
	}
	return PLUGIN_HANDLED;
}

// ---- natives for h9_community.sma (and any plugin): include/h9_community.inc ---------------------

public plugin_natives()
{
	register_library("h9_presence");
	register_native("h9p_ready", "nat_ready");
	register_native("h9p_server", "nat_server");
	register_native("h9p_server_id", "nat_server_id");
	register_native("h9p_api", "nat_api");
	register_native("h9p_sign", "nat_sign");
	register_native("h9p_nonce", "nat_nonce");
	register_native("h9p_report_soon", "nat_report_soon");
	register_native("h9p_muted", "nat_muted");
	register_native("h9p_challenge", "nat_challenge");
	register_native("h9p_account", "nat_account");
	register_native("h9p_account_name", "nat_account_name");
	register_native("h9p_roles", "nat_roles");
}

public nat_ready(plugin, params)
{
	return g_ready && g_key[0] && g_estate == ES_ACTIVE;
}

public nat_server(plugin, params)
{
	set_string(1, g_server, get_param(2));
	return g_server[0] != 0;
}

public nat_server_id(plugin, params)
{
	set_string(1, g_serverid, get_param(2));
	return g_serverid[0] != 0;
}

public nat_api(plugin, params)
{
	new url[200];
	api_url(url, charsmax(url), "");
	set_string(1, url, get_param(2));
	return 1;
}

/** h9p_sign(const body[], out[], len): the live key's HMAC-SHA256 of body, as 64 hex. */
public nat_sign(plugin, params)
{
	if (!g_key[0] || g_estate != ES_ACTIVE)
	{
		return 0;
	}
	get_string(1, g_signbuf, charsmax(g_signbuf));
	new sig[65];
	hmac_sha256(g_key, strlen(g_key), g_signbuf, strlen(g_signbuf), sig, charsmax(sig));
	set_string(2, sig, get_param(3));
	return 1;
}

public nat_nonce(plugin, params)
{
	new n[17];
	make_nonce(n);
	set_string(1, n, get_param(2));
	return 1;
}

public nat_report_soon(plugin, params)
{
	soon();
	return 1;
}

/** h9p_challenge(id, const nonce[]): a plugin's own challenge; the answer comes in h9p_proof. */
public nat_challenge(plugin, params)
{
	new id = get_param(1);
	new nonce[40];
	get_string(2, nonce, charsmax(nonce));
	if (id < 1 || id > g_max || !g_in[id] || strlen(nonce) != 32)
	{
		return 0;
	}
	for (new i = 0; i < 32; i++)
	{
		if (!((nonce[i] >= '0' && nonce[i] <= '9') || (nonce[i] >= 'a' && nonce[i] <= 'f')))
		{
			return 0;
		}
	}
	client_cmd(id, "h9_idchallenge %s", nonce);
	return 1;
}

public nat_muted(plugin, params)
{
	new id = get_param(1);
	return id >= 1 && id <= g_max && g_muted[id];
}

/** h9p_account(id): the slot's proven havoc9.org account (accounts.id), 0 for none. */
public nat_account(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id > g_max || !g_in[id])
	{
		return 0;
	}
	return g_acct[id];
}

/** h9p_account_name(id, out[], len): that account's username; false (and "") for no account. */
public nat_account_name(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id > g_max || !g_in[id] || !g_acct[id])
	{
		set_string(2, "", get_param(3));
		return 0;
	}
	set_string(2, g_uname[id], get_param(3));
	return 1;
}

/** h9p_roles(id, out[], len): its roles here, comma-separated; false (and "") for no account. */
public nat_roles(plugin, params)
{
	new id = get_param(1);
	if (id < 1 || id > g_max || !g_in[id] || !g_acct[id])
	{
		set_string(2, "", get_param(3));
		return 0;
	}
	set_string(2, g_roles[id], get_param(3));
	return 1;
}

// ---- the scoreboard's pictures -------------------------------------------------------------------

/** H9Avatar to one client (to > 0) or to every client (0): byte slot, long account, long version. */
send_avatar(to, slot, account, version)
{
	if (!g_msg_avatar)
	{
		return;
	}
	if (to)
	{
		if (!is_user_connected(to) || is_user_bot(to))
		{
			return;
		}
		engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg_avatar, Float:{0.0, 0.0, 0.0}, to);
	}
	else
	{
		engfunc(EngFunc_MessageBegin, MSG_ALL, g_msg_avatar, Float:{0.0, 0.0, 0.0}, 0);
	}
	write_byte(slot);
	write_long(account);
	write_long(version);
	message_end();
}

/** H9Link to one client (to) or every client (0): the slot is a proven havoc9.org account (1), not (0), or a bot (2). */
send_link(to, slot, linked)
{
	if (!g_msg_link)
	{
		return;
	}
	if (to)
	{
		if (!is_user_connected(to) || is_user_bot(to))
		{
			return;
		}
		engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg_link, Float:{0.0, 0.0, 0.0}, to);
	}
	else
	{
		engfunc(EngFunc_MessageBegin, MSG_ALL, g_msg_link, Float:{0.0, 0.0, 0.0}, 0);
	}
	write_byte(slot);
	write_byte(linked);
	message_end();
}

/** H9Level to one client (to) or every client (0): the slot's level, 0 to 99, or 255 for none. */
send_level(to, slot, level)
{
	if (!g_msg_level)
	{
		return;
	}
	if (to)
	{
		if (!is_user_connected(to) || is_user_bot(to))
		{
			return;
		}
		engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg_level, Float:{0.0, 0.0, 0.0}, to);
	}
	else
	{
		engfunc(EngFunc_MessageBegin, MSG_ALL, g_msg_level, Float:{0.0, 0.0, 0.0}, 0);
	}
	write_byte(slot);
	write_byte(level);
	message_end();
}

/** H9Account to one client (to) or every client (0): a linked slot's own account number, 0 for none. */
send_account(to, slot, account)
{
	if (!g_msg_account)
	{
		return;
	}
	if (to)
	{
		if (!is_user_connected(to) || is_user_bot(to))
		{
			return;
		}
		engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg_account, Float:{0.0, 0.0, 0.0}, to);
	}
	else
	{
		engfunc(EngFunc_MessageBegin, MSG_ALL, g_msg_account, Float:{0.0, 0.0, 0.0}, 0);
	}
	write_byte(slot);
	write_long(account);
	message_end();
}

/** The answer's "levels": { "<slot>": level }, for proven players; a slot not there has none. */
apply_levels(EzJSON:root)
{
	new bool:any = ezjson_object_has_value(root, "levels", EzJSONObject);
	new key[32], lv;
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		lv = 0;
		formatex(key, charsmax(key), "levels.%d", id);
		if (any && ezjson_object_has_value(root, key, EzJSONNumber, true))
		{
			lv = clamp(ezjson_object_get_number(root, key, true), 0, 99) + 1;
		}
		if (lv != g_level[id])
		{
			g_level[id] = lv;
			send_level(0, id, lv ? lv - 1 : 255);
		}
	}
}

/** The answer's "avatars": { "<slot>": { "a": account, "v": version } }, for proven players. */
apply_avatars(EzJSON:root)
{
	if (!ezjson_object_has_value(root, "avatars", EzJSONObject))
	{
		return;
	}
	new key[32], a, v;
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "avatars.%d.a", id);
		a = ezjson_object_has_value(root, key, EzJSONNumber, true) ? ezjson_object_get_number(root, key, true) : 0;
		formatex(key, charsmax(key), "avatars.%d.v", id);
		v = ezjson_object_has_value(root, key, EzJSONNumber, true) ? ezjson_object_get_number(root, key, true) : 0;
		if (a < 0 || v < 0)
		{
			a = 0;
			v = 0;
		}
		if (a != g_av_account[id] || v != g_av_version[id])
		{
			g_av_account[id] = a;
			g_av_version[id] = v;
			send_avatar(0, id, a, v);
		}
		if ((a != 0) != g_linked[id])
		{
			g_linked[id] = a != 0;
			send_link(0, id, g_linked[id] ? 1 : 0);
		}
	}
}

/**
 * The answer's "accounts": { "<slot>": account }, each linked player's own account number (h9web
 * names the slots "avatars" names, the ones with the chain), for H9XASH's h9_profile and for other
 * plugins (h9p_account), with "usernames" and "roles" for the same slots (h9p_account_name,
 * h9p_roles). A slot without the chain is told none, whatever the answer says. An answer without
 * "accounts" (an older h9web) changes nothing; one without "usernames" or "roles" (h9web before
 * h9_presence 1.9) leaves them empty.
 */
apply_accounts(EzJSON:root)
{
	if (!ezjson_object_has_value(root, "accounts", EzJSONObject))
	{
		return;
	}
	new key[32], a, name[64], roles[96];
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "accounts.%d", id);
		a = ezjson_object_has_value(root, key, EzJSONNumber, true) ? ezjson_object_get_number(root, key, true) : 0;
		if (a < 0 || !g_linked[id])
		{
			a = 0;
		}
		name[0] = 0;
		roles[0] = 0;
		if (a)
		{
			formatex(key, charsmax(key), "usernames.%d", id);
			if (ezjson_object_has_value(root, key, EzJSONString, true))
			{
				ezjson_object_get_string(root, key, name, charsmax(name), true);
			}
			formatex(key, charsmax(key), "roles.%d", id);
			if (ezjson_object_has_value(root, key, EzJSONString, true))
			{
				ezjson_object_get_string(root, key, roles, charsmax(roles), true);
			}
		}
		set_account(id, a, name, roles);
	}
}

/**
 * A slot's account (0: none), its username and its roles, as h9p_account, h9p_account_name and
 * h9p_roles give them: every client hears in H9Account when the account changes, and the other
 * plugins in h9p_account_changed when any of the three does.
 */
set_account(id, account, const name[], const roles[])
{
	new bool:changed = false;
	if (account != g_acct[id])
	{
		g_acct[id] = account;
		send_account(0, id, account);
		changed = true;
	}
	if (!equal(name, g_uname[id]))
	{
		copy(g_uname[id], charsmax(g_uname[]), name);
		changed = true;
	}
	if (!equal(roles, g_roles[id]))
	{
		copy(g_roles[id], charsmax(g_roles[]), roles);
		changed = true;
	}
	if (changed)
	{
		new ret;
		ExecuteForward(g_fwd_account, ret, id, account);
	}
}

/**
 * h9web's word on this listen server's own player ("host": "proven", "known" or "unknown"),
 * logged when it changes: "unknown" is a game whose player id is no havoc9.org account's.
 */
apply_host(EzJSON:root)
{
	new word[16];
	word[0] = 0;
	if (ezjson_object_has_value(root, "host", EzJSONString))
	{
		ezjson_object_get_string(root, "host", word, charsmax(word));
	}
	if (!word[0] || equal(word, g_hoststate))
	{
		return;
	}
	copy(g_hoststate, charsmax(g_hoststate), word);
	if (equal(word, "proven"))
	{
		log_amx("[PRESENCE] This game's own player is a proven havoc9.org account here.");
	}
	else if (equal(word, "known"))
	{
		log_amx("[PRESENCE] havoc9.org knows this game's own player but has no proof yet: an H9XASH from before 2026-11-02, or h9_presence_challenge 0.");
	}
	else
	{
		log_amx("[PRESENCE] havoc9.org does not know this game's own player: the player id in H9XASH's user_id.ini is not a havoc9.org account's (the ACCOUNT page shows the start of yours; docs/CUSTOM_XASH_USERID.txt).");
	}
}

/** A client that just joined: every slot's picture there is, who is linked, each level and account. */
public task_avatars_to(task)
{
	new to = task - TASK_AVATARS;
	for (new id = 1; id <= g_max; id++)
	{
		if (g_av_account[id])
		{
			send_avatar(to, id, g_av_account[id], g_av_version[id]);
		}
		if (g_linked[id])
		{
			send_link(to, id, 1);
		}
		else if (g_isbot[id])
		{
			send_link(to, id, 2);
		}
		if (g_level[id])
		{
			send_level(to, id, g_level[id] - 1);
		}
		if (g_acct[id])
		{
			send_account(to, id, g_acct[id]);
		}
	}
}

// ---- names ------------------------------------------------------------------------------------

/**
 * h9web's answer to a report that asked for names: per slot, "set" (a proven account: play under
 * its username, the current one, so a rename on the site follows) or "taken" (someone else using
 * an account's name, look-alikes included: a neutral name instead). Only for a slot still held by
 * the player the report was about.
 */
apply_names(EzJSON:root)
{
	new key[32], name[64];
	for (new id = 1; id <= g_max; id++)
	{
		if (!g_in[id] || g_sent_gen[id] != g_gen[id])
		{
			continue;
		}
		formatex(key, charsmax(key), "names.%d.set", id);
		if (ezjson_object_has_value(root, key, EzJSONString, true))
		{
			ezjson_object_get_string(root, key, name, charsmax(name), true);
			if (name[0])
			{
				force_name(id, name, false);
			}
			continue;
		}
		formatex(key, charsmax(key), "names.%d.taken", id);
		if (ezjson_object_has_value(root, key, EzJSONBoolean, true) && !g_neutral[id])
		{
			// "Player 1234": a space, which no username can hold, so it is never an account's
			formatex(name, charsmax(name), "Player %d", random_num(1000, 9999));
			force_name(id, name, true);
		}
	}
}

force_name(id, const name[], bool:neutral)
{
	copy(g_forced[id], charsmax(g_forced[]), name);
	g_neutral[id] = neutral;
	new was[64];
	get_user_name(id, was, charsmax(was));
	if (equal(was, name))
	{
		return;
	}
	set_user_info(id, "name", name);
	tell(id);
}

/** One short line on why the name changed, at most every 10 seconds per player. */
tell(id)
{
	new now = get_systime();
	if (now - g_told[id] < 10)
	{
		return;
	}
	g_told[id] = now;
	if (g_neutral[id])
	{
		client_print(id, print_chat, "[H9] That name belongs to a havoc9.org account. On H9 maps you play as %s.", g_forced[id]);
	}
	else
	{
		client_print(id, print_chat, "[H9] On H9 maps you play under your havoc9.org name, %s.", g_forced[id]);
	}
}

/// A roleplay map by its name: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ anywhere in it.
/// Copied exactly from roleplay_map() in ts_matchmode.sma; keep the two the same.
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

/** Names are free on roleplay maps and on stock TS maps (ts_), and fixed on every other map. */
bool:names_free(const map[])
{
	return roleplay_map(map) || equali(map, "ts_", 3);
}

// ---- the mode, as the Discord card names it -----------------------------------------------------

pres(pcvar, out[], len)
{
	out[0] = 0;
	if (pcvar)
	{
		get_pcvar_string(pcvar, out, len);
		trim(out);
	}
}

/**
 * H9P_Mode in engine/client/cl_presence.c, in Pawn: the server's own word first (tsm_pres_siege,
 * tsm_pres_mode), then the map's name (h9_<mode>_ prefixes, then rp_ / tsrp_ for Roleplay), then
 * "match" for Match Mode, else Deathmatch.
 */
mode_name(const map[], const key[], const siege[], out[], len)
{
	if (siege[0] || equali(key, "siege"))
	{
		copy(out, len, "Siege");
		return;
	}
	if (equali(key, "uplink"))
	{
		copy(out, len, "Capture the Uplink");
		return;
	}
	if (equali(key, "survival"))
	{
		copy(out, len, "Wave Survival");
		return;
	}
	if (equali(key, "mechwarrior"))
	{
		copy(out, len, "Mech Warrior");
		return;
	}
	if (equali(key, "assault"))
	{
		copy(out, len, "Assault");
		return;
	}
	if (equali(key, "ctf"))
	{
		copy(out, len, "Capture the Flag");
		return;
	}
	new name[64];
	copy(name, charsmax(name), map);
	strtolower(name);
	if (equal(name, "h9_te_", 6))
	{
		copy(out, len, "Team Elimination");
	}
	else if (equal(name, "h9_siege_", 9))
	{
		copy(out, len, "Siege");
	}
	else if (equal(name, "h9_up_", 6))
	{
		copy(out, len, "Capture the Uplink");
	}
	else if (equal(name, "h9_mw_", 6))
	{
		copy(out, len, "Mech Warrior");
	}
	else if (equal(name, "h9_ws_", 6))
	{
		copy(out, len, "Wave Survival");
	}
	else if (equal(name, "h9_as_", 6))
	{
		copy(out, len, "Assault");
	}
	else if (equal(name, "h9_dm_", 6))
	{
		copy(out, len, "Deathmatch");
	}
	else if (equal(name, "h9_tdm_", 7))
	{
		copy(out, len, "Team Deathmatch");
	}
	else if (equal(name, "h9_ctb_", 7))
	{
		copy(out, len, "Capture the Briefcase");
	}
	else if (equal(name, "h9_ctf_", 7))
	{
		copy(out, len, "Capture the Flag");
	}
	else if (equal(name, "rp_", 3) || equal(name, "tsrp_", 5) || contain(name, "_rp_") >= 0 || contain(name, "_tsrp_") >= 0)
	{
		copy(out, len, "Roleplay");
	}
	else if (equal(name, "ctb_", 4) || contain(name, "_ctb_") >= 0)
	{
		copy(out, len, "Capture the Briefcase");
	}
	else if (equal(name, "ctf_", 4) || contain(name, "_ctf_") >= 0)
	{
		copy(out, len, "Capture the Flag");
	}
	else if (equali(key, "match"))
	{
		copy(out, len, "Match Mode");
	}
	else
	{
		copy(out, len, "Deathmatch");
	}
}

/**
 * The card's details line (H9P_Activity): the siege's attacking side and objectives, the
 * uplink's zones, the assault's points, the survival wave, or the mode alone.
 */
detail_line(const mode[], const key[], const siege[], const attack[], const prog[], out[], len)
{
	new side[40];
	side[0] = 0;
	if (attack[0] == '1' || attack[0] == '2')
	{
		team_label(attack[0] - '0', false, side, charsmax(side));
	}

	if (siege[0] && side[0])
	{
		new slash = contain(siege, "/");
		formatex(out, len, "%s - %s attacking: %d of %d objectives", mode, side, str_to_num(siege), slash >= 0 ? str_to_num(siege[slash + 1]) : 0);
	}
	else if (siege[0])
	{
		formatex(out, len, "%s %s", mode, siege);
	}
	else if ((equali(key, "uplink") || equali(key, "assault") || equali(key, "ctf")) && prog[0])
	{
		new what[12];
		copy(what, charsmax(what), equali(key, "assault") ? "points" : (equali(key, "ctf") ? "captures" : "zones"));
		new held[3], at = 0, cut;
		for (new i = 0; i < 3; i++)
		{
			held[i] = str_to_num(prog[at]);
			cut = contain(prog[at], "/");
			if (cut < 0)
			{
				break;
			}
			at += cut + 1;
		}
		new t1[40], t2[40];
		team_label(1, false, t1, charsmax(t1));
		team_label(2, false, t2, charsmax(t2));
		formatex(out, len, "%s - %s: %s %d, %s %d of %d", mode, what, t1, held[0], t2, held[1], held[2]);
		// h9web keeps 96 characters of it: long names go short
		if (strlen(out) > 90)
		{
			team_label(1, true, t1, charsmax(t1));
			team_label(2, true, t2, charsmax(t2));
			formatex(out, len, "%s - %s: %s %d, %s %d of %d", mode, what, t1, held[0], t2, held[1], held[2]);
		}
	}
	else if (equali(key, "survival") && prog[0])
	{
		formatex(out, len, "%s - wave %d", mode, str_to_num(prog));
	}
	else
	{
		copy(out, len, mode);
	}
}

/**
 * A side's name as the game shows it: entry 1 or 2 of mp_teamlist when it is set and has that entry
 * ("Middle Sea Republic;Insurrectionists;Spectator" on H9XASH), else ts_matchmode's
 * tsm_team1_name or tsm_team2_name ("msr", "insurgents" on GoldSrc), else MSR and Insurgents; up to
 * 39 characters. short: the initials of a name of several words that is longer than 12 characters
 * ("Middle Sea Republic" is "MSR").
 */
team_label(team, bool:short, out[], len)
{
	new name[40];
	team_from_list(team, name, charsmax(name));
	if (!name[0])
	{
		new cv = get_cvar_pointer(team == 1 ? "tsm_team1_name" : "tsm_team2_name");
		if (cv)
		{
			get_pcvar_string(cv, name, charsmax(name));
			trim(name);
		}
	}
	if (!name[0])
	{
		copy(out, len, team == 1 ? "MSR" : "Insurgents");
		return;
	}
	if (!short || strlen(name) <= 12 || contain(name, " ") < 0)
	{
		copy(out, len, name);
		return;
	}
	new n = 0;
	for (new i = 0; name[i] && n < len; i++)
	{
		if (name[i] != ' ' && (i == 0 || name[i - 1] == ' '))
		{
			out[n++] = (name[i] >= 'a' && name[i] <= 'z') ? name[i] - 32 : name[i];
		}
	}
	out[n] = 0;
}

/** Entry team (1 or 2) of mp_teamlist ("a;b;c"), trimmed; "" when it is not set or has no such entry. */
team_from_list(team, out[], len)
{
	out[0] = 0;
	new cv = get_cvar_pointer("mp_teamlist");
	if (!cv)
	{
		return;
	}
	new list[192];
	get_pcvar_string(cv, list, charsmax(list));
	new at = 0, cut;
	for (new i = 1; i < team; i++)
	{
		cut = contain(list[at], ";");
		if (cut < 0)
		{
			return;
		}
		at += cut + 1;
	}
	cut = contain(list[at], ";");
	if (cut >= 0)
	{
		list[at + cut] = 0;
	}
	copy(out, len, list[at]);
	trim(out);
}

// ---- the JSON body ------------------------------------------------------------------------------

app_byte(b)
{
	if (g_len >= MAX_BODY - 1)
	{
		return;
	}
	g_body[g_len] = b & 0xFF;
	g_len++;
	g_body[g_len] = 0;
}

app_raw(const s[])
{
	for (new i = 0; s[i]; i++)
	{
		app_byte(s[i]);
	}
}

app_num(n)
{
	new t[16];
	num_to_str(n, t, charsmax(t));
	app_raw(t);
}

/** A JSON string: quoted, with " and the backslash escaped and control characters as u00XX. */
app_str(const s[])
{
	app_byte(34);
	for (new i = 0; s[i]; i++)
	{
		new c = s[i] & 0xFF;
		if (c == 0)
		{
			continue;
		}
		if (c == 34 || c == 92)
		{
			app_byte(92);
			app_byte(c);
		}
		else if (c < 32 || c == 127)
		{
			app_byte(92);
			app_raw("u00");
			app_byte(HEX[(c >> 4) & 15]);
			app_byte(HEX[c & 15]);
		}
		else
		{
			app_byte(c);
		}
	}
	app_byte(34);
}

// ---- SHA-256 and HMAC-SHA256 (FIPS 180-4, RFC 2104) ---------------------------------------------

new const g_k[64] =
{
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

new g_h[8];
new g_w[64];
new g_block[64];
new g_blen;
new g_total;
new g_digest[32];
new g_kpad[64];
new g_inner[32];

rotr(x, n)
{
	return (x >>> n) | (x << (32 - n));
}

sha_init()
{
	g_h[0] = 0x6a09e667;
	g_h[1] = 0xbb67ae85;
	g_h[2] = 0x3c6ef372;
	g_h[3] = 0xa54ff53a;
	g_h[4] = 0x510e527f;
	g_h[5] = 0x9b05688c;
	g_h[6] = 0x1f83d9ab;
	g_h[7] = 0x5be0cd19;
	g_blen = 0;
	g_total = 0;
}

sha_block()
{
	new i, s0, s1, t1, t2, a, b, c, d, e, f, g, h;
	for (i = 0; i < 16; i++)
	{
		g_w[i] = (g_block[i * 4] << 24) | (g_block[i * 4 + 1] << 16) | (g_block[i * 4 + 2] << 8) | g_block[i * 4 + 3];
	}
	for (i = 16; i < 64; i++)
	{
		s0 = rotr(g_w[i - 15], 7) ^ rotr(g_w[i - 15], 18) ^ (g_w[i - 15] >>> 3);
		s1 = rotr(g_w[i - 2], 17) ^ rotr(g_w[i - 2], 19) ^ (g_w[i - 2] >>> 10);
		g_w[i] = g_w[i - 16] + s0 + g_w[i - 7] + s1;
	}
	a = g_h[0];
	b = g_h[1];
	c = g_h[2];
	d = g_h[3];
	e = g_h[4];
	f = g_h[5];
	g = g_h[6];
	h = g_h[7];
	for (i = 0; i < 64; i++)
	{
		s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
		t1 = h + s1 + ((e & f) ^ (~e & g)) + g_k[i] + g_w[i];
		s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
		t2 = s0 + ((a & b) ^ (a & c) ^ (b & c));
		h = g;
		g = f;
		f = e;
		e = d + t1;
		d = c;
		c = b;
		b = a;
		a = t1 + t2;
	}
	g_h[0] += a;
	g_h[1] += b;
	g_h[2] += c;
	g_h[3] += d;
	g_h[4] += e;
	g_h[5] += f;
	g_h[6] += g;
	g_h[7] += h;
}

sha_byte(value)
{
	g_block[g_blen] = value & 0xFF;
	g_blen++;
	g_total++;
	if (g_blen == 64)
	{
		sha_block();
		g_blen = 0;
	}
}

sha_final()
{
	// the length in bits, as two 32-bit halves, taken before the padding is added
	new hi = g_total >>> 29;
	new lo = g_total << 3;
	sha_byte(0x80);
	while (g_blen != 56)
	{
		sha_byte(0);
	}
	sha_byte(hi >>> 24);
	sha_byte(hi >>> 16);
	sha_byte(hi >>> 8);
	sha_byte(hi);
	sha_byte(lo >>> 24);
	sha_byte(lo >>> 16);
	sha_byte(lo >>> 8);
	sha_byte(lo);
	for (new i = 0; i < 8; i++)
	{
		g_digest[i * 4] = (g_h[i] >>> 24) & 0xFF;
		g_digest[i * 4 + 1] = (g_h[i] >>> 16) & 0xFF;
		g_digest[i * 4 + 2] = (g_h[i] >>> 8) & 0xFF;
		g_digest[i * 4 + 3] = g_h[i] & 0xFF;
	}
}

to_hex(const bytes[], n, out[], len)
{
	new j = 0;
	for (new i = 0; i < n && j + 2 <= len; i++)
	{
		out[j] = HEX[(bytes[i] >> 4) & 15];
		out[j + 1] = HEX[bytes[i] & 15];
		j += 2;
	}
	out[j] = 0;
}

sha256_text(const text[], out[], len)
{
	sha_init();
	for (new i = 0; text[i]; i++)
	{
		sha_byte(text[i]);
	}
	sha_final();
	to_hex(g_digest, 32, out, len);
}

/** HMAC-SHA256(key, msg) as lowercase hex in out (len 64 or more). */
hmac_sha256(const key[], keylen, const msg[], msglen, out[], len)
{
	new i;
	for (i = 0; i < 64; i++)
	{
		g_kpad[i] = 0;
	}
	if (keylen > 64)
	{
		sha_init();
		for (i = 0; i < keylen; i++)
		{
			sha_byte(key[i]);
		}
		sha_final();
		for (i = 0; i < 32; i++)
		{
			g_kpad[i] = g_digest[i];
		}
	}
	else
	{
		for (i = 0; i < keylen; i++)
		{
			g_kpad[i] = key[i] & 0xFF;
		}
	}
	sha_init();
	for (i = 0; i < 64; i++)
	{
		sha_byte(g_kpad[i] ^ 0x36);
	}
	for (i = 0; i < msglen; i++)
	{
		sha_byte(msg[i]);
	}
	sha_final();
	for (i = 0; i < 32; i++)
	{
		g_inner[i] = g_digest[i];
	}
	sha_init();
	for (i = 0; i < 64; i++)
	{
		sha_byte(g_kpad[i] ^ 0x5C);
	}
	for (i = 0; i < 32; i++)
	{
		sha_byte(g_inner[i]);
	}
	sha_final();
	to_hex(g_digest, 32, out, len);
}

/** The FIPS 180-4 and RFC 4231 vectors, and a long text against AMXX's own SHA-256. */
bool:self_test()
{
	new out[65], ref[65];
	sha256_text("abc", out, charsmax(out));
	if (!equal(out, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
	{
		return false;
	}
	sha256_text("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", out, charsmax(out));
	if (!equal(out, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"))
	{
		return false;
	}
	hmac_sha256("Jefe", 4, "what do ya want for nothing?", 28, out, charsmax(out));
	if (!equal(out, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"))
	{
		return false;
	}
	for (new i = 0; i < charsmax(g_scratch); i++)
	{
		g_scratch[i] = 'a' + (i * 7) % 26;
	}
	g_scratch[charsmax(g_scratch)] = 0;
	sha256_text(g_scratch, out, charsmax(out));
	hash_string(g_scratch, Hash_Sha256, ref, charsmax(ref));
	strtolower(ref);
	return bool:equal(out, ref);
}

// ---- the server console -------------------------------------------------------------------------

public cmd_status()
{
	server_print("[PRESENCE] %s %s", PLUGIN, VERSION);
	server_print("  self-test: %s", g_selftest ? "passed" : "FAILED (nothing is reported)");
	server_print("  config: %s (server ^"%s^", key %s)", g_ready ? "reporting" : "not reporting", g_server, g_key[0] ? "set" : "not set");
	new const STATES[][] = { "not enrolled", "enrolled, waiting for h9web to see the code", "enrolled, waiting for an H9 admin", "live" };
	server_print("  enrollment: %s%s; server id %s", g_manual ? "a hand-made key" : STATES[g_estate], is_dedicated_server() ? "" : " (a listen server: enrolled by its own player's ID proof)", g_serverid[0] ? g_serverid : "none yet");
	server_print("  challenge: %s; names: %s", get_pcvar_num(g_cv_challenge) ? "on" : "off", g_names ? "fixed on this map" : "free on this map");
	if (!is_dedicated_server())
	{
		server_print("  this game's own player: %s", g_hoststate[0] ? g_hoststate : "not reported yet");
	}
	server_print("  accounts only: %s%s", get_pcvar_num(g_cv_require) == 1 ? "on" : "off",
		get_pcvar_num(g_cv_require) != 1 ? "" : !g_ready ? " (not reporting: nobody is kicked for it)" : h9web_answering() ? " (h9web answering)" : " (h9web not answering lately: nobody is kicked for it)");
	new ids = 0, proven = 0;
	for (new id = 1; id <= g_max; id++)
	{
		if (g_in[id])
		{
			ids++;
			if (g_proof[id][0])
			{
				proven++;
			}
		}
	}
	server_print("  players in game: %d (with a proof: %d); in the last accepted report: %d", ids, proven, g_last_count < 0 ? 0 : g_last_count);
	server_print("  reports accepted this map: %d; last outcome: %d", g_accepted, g_last_status);
	server_print("  what this server runs: %d file(s) listed for h9web; %s", g_comp_n, g_comp_due ? "goes in the next report" : "h9web has it");
	server_print("  h9_authenticated: %s", get_pcvar_num(g_cv_auth) ? "1 (h9web judges what this server runs)" : "0 (this server asks not to be authenticated or rated)");
	return PLUGIN_HANDLED;
}
