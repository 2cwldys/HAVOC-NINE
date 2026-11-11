/*
 * h9_tts -- what a player says in chat, spoken to the players near him. docs\TEXT_TO_SPEECH.txt is the
 * guide: what it is, the protocol, the cvars, limits, privacy and what a server can do about abuse.
 *
 * The server only decides who hears what, how loudly and in which voice; the speaking is done by each
 * player's own game (H9's client.dll: Windows SAPI on a native client, the browser's speech synthesis
 * on the web client). One user message tells it, H9Tts, sent to each listener:
 *
 *   byte    the speaker's slot
 *   byte    the voice: 0 a man, 1 a woman, 2 a Mech, 3 a bot
 *   byte    the volume, 0 to 100: full within a quarter of h9_tts_range, fading to nothing at the range
 *   byte    flags: bit 0 (1) says a gas mask muffles the voice; bit 2 (4) says the line is global
 *   string  the words, at most h9_tts_maxchars of them
 *   byte    the variant the speaker asked others to hear him with   } the tail: a game that does not know
 *   char    the depth he asked for                                  } it reads the message as it was
 *   char    the pan: where he is in the listener's ears             }
 *   byte    1 when the bot voice is a droid's (a model with droid in its name); only the Kokoro voices tell a droid from a bot
 *
 * A LISTENER is a living human whose game says it can speak: the userinfo key _h9tts is 1 (H9's client
 * sets it while cl_h9_tts is 1 and the machine has a voice). A game without the key is sent nothing.
 * Walls do not matter, distance does. say_team is heard by the speaker's team only.
 *
 * GLOBAL (h9_tts_global 1): a line is heard by every human whose game speaks, wherever he is and alive or not, at full volume
 * and from no direction (flag bit 2 says so). It changes whom the SPEECH is sent to and nothing about the chat text, and
 * never to more players than the text reaches: say_team stays with the speaker's team, the speaker's own rules (alive, not
 * muted, drawn, not a command) hold, and a roleplay map keeps its talk area (ARP_TalkArea decides who sees a line there,
 * after this plugin has run), so global does nothing on one.
 *
 * THE VOICE comes from the speaker's model name alone (the userinfo key "model"), never from a match
 * mode, a class or a perk, so it is the same on a plain TS server: a name with "mech" or "ed209" in it
 * is a Mech; "droid", "robo" or "_bot" a bot; "fem", "woman", "women", "girl" or "lady" a woman; the rest
 * a man. A man's or a woman's voice is muffled when the model is on the gas-masked list, h9_tts_gasmask.cfg
 * in the configs folder: one model name a line, in any case.
 */
#include <amxmodx>
#include <amxmisc>
#include <fakemeta>

#define H9C_CORE
#include <h9_community>

#define PLUGIN  "H9 Text To Speech"
#define VERSION "1.2"
#define AUTHOR  "H9"

// The voices of the H9Tts message, and its flags.
#define TTS_MAN        0
#define TTS_WOMAN      1
#define TTS_MECH       2
#define TTS_BOT        3
#define TTS_F_MUFFLED  1
#define TTS_F_GLOBAL   4        // bit 1 (2) is the hello message's
#define TTS_F_DROID    128      // not sent: voice_of says the bot is a droid (the tail byte)

#define TTS_EF_NODRAW  128      // From the HL SDK.
#define TTS_RAW_LEN    192      // what is read of a line
#define TTS_MAX_LIMIT  150      // the most h9_tts_maxchars may be: the message stays far under 188 bytes
#define TTS_CUT_BACK   12       // a cut line is taken back to a space this near the end
#define TTS_MASK_FILE  "h9_tts_gasmask.cfg"
#define TTS_MASK_PREFIXES 24    // the most name starts (repuheavy*) the mask list may hold
#define TTS_LISTENER_GAP 0.3    // seconds that give a listener one more line to be sent, from all speakers together
#define TTS_LISTENER_BURST 4    // lines a listener may be sent at once before that rate holds
#define TTS_VARIANT_MAX 99      // the highest voice variant a speaker may ask for
#define TTS_DEPTH_MAX  10       // how far, either way, a speaker may move his voice

new const g_mech_words[][]  = { "mech", "ed209" };
new const g_bot_words[][]   = { "droid", "robo", "_bot" };
new const g_droid_words[][] = { "droid" };
new const g_woman_words[][] = { "fem", "woman", "women", "girl", "lady" };

new g_msg;                              // the H9Tts user message
new g_cv_on, g_cv_range, g_cv_maxchars, g_cv_gap, g_cv_self, g_cv_global;
new Float:g_last[MAX_PLAYERS + 1];      // when each player was last spoken
new Trie:g_masked;                      // the gas-masked model names, lower case
new Trie:g_unmasked;                    // the models the mask list takes out again (a line !name)
new g_mask_prefix[TTS_MASK_PREFIXES][32]; // the starts of model names that are gas-masked (a line name*)
new g_mask_prefixes;
new g_pref_variant[MAX_PLAYERS + 1];    // the voice variant each speaker asked others to hear him with (h9_ttsvoice); 0 leaves it to them
new g_pref_depth[MAX_PLAYERS + 1];      // how deep (below 0) or high (above 0) each speaker asked to sound
new Float:g_credit[MAX_PLAYERS + 1];    // lines each listener may still be sent at once (up to TTS_LISTENER_BURST); one comes back every TTS_LISTENER_GAP
new Float:g_credit_at[MAX_PLAYERS + 1]; // when g_credit was last worked out
new bool:g_roleplay;                    // this map is a roleplay map (roleplay_map), where the talk area decides who hears
new bool:g_have_presence = true;        // h9_presence's natives are bound (native_filter)
new g_maxplayers;

public plugin_natives()
{
	set_native_filter("native_filter");
}

// h9_presence may be missing: its natives go unbound, and a call to one marks it gone and answers 0.
public native_filter(const name[], index, trap)
{
	if (!trap)
	{
		return PLUGIN_HANDLED;
	}
	if (equal(name, "h9p_", 4))
	{
		g_have_presence = false;
		return PLUGIN_HANDLED;
	}
	return PLUGIN_CONTINUE;
}

public plugin_precache()
{
	// Variable length (-1), registered whatever h9_texttospeech says, so that every game learns the
	// message at connect, as it does H9Vgui (include/h9_vgui.inc, h9vgui_precache).
	g_msg = engfunc(EngFunc_RegUserMsg, "H9Tts", -1);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_maxplayers = min(get_maxplayers(), MAX_PLAYERS);

	// 1: chat is spoken to the players near the speaker. 0: nothing is sent (the default).
	g_cv_on       = register_cvar("h9_texttospeech", "0");
	// Units from the speaker out to which a line is heard; the volume fades out to it.
	g_cv_range    = register_cvar("h9_tts_range", "800");
	// The most characters of a line that are spoken (8 to 150); a longer one is cut.
	g_cv_maxchars = register_cvar("h9_tts_maxchars", "96");
	// Seconds a speaker must wait between two spoken lines; what he says in between is only written.
	g_cv_gap      = register_cvar("h9_tts_gap", "1.5");
	// 1: the speaker hears his own line too, which is how one player alone can tell it works. 0: only the others.
	g_cv_self     = register_cvar("h9_tts_self", "1");
	// 1: a line is heard by every human with text to speech, wherever he is, at full volume and from no direction (never by more than
	// the text reaches: say_team stays with the speaker's team, and a roleplay map keeps its talk area). 0: the players within the range.
	g_cv_global   = register_cvar("h9_tts_global", "0", FCVAR_SERVER);

	register_clcmd("say",      "cmd_say");
	register_clcmd("say_team", "cmd_say");
	// From a player's console: the state of text to speech, and for an admin a switch. h9_texttospeech is a server cvar, which a
	// game that is not the server's own cannot see, so the same name is also a command the server answers.
	register_clcmd("h9_texttospeech", "cmd_tts", ADMIN_ALL, "[0|1] - text to speech: its state, and (admin) on or off");
	register_clcmd("h9_tts",         "cmd_tts", ADMIN_ALL, "[0|1] - text to speech: its state, and (admin) on or off");
	// From a player's game: how he asks others to hear him (cl_h9_tts_myvoice and cl_h9_tts_mydepth, sent as the game starts and when they change).
	register_clcmd("h9_ttsvoice",    "cmd_ttsvoice", ADMIN_ALL, "[variant 0-99] [depth -10..10] - the voice others hear you with");

	new map[64];
	get_mapname(map, charsmax(map));
	g_roleplay = roleplay_map(map);

	g_masked = TrieCreate();
	g_unmasked = TrieCreate();
}

/// A roleplay map by its name: rp_ or tsrp_ at the start, or _rp_ or _tsrp_ anywhere in it (the rule ts_matchmode and ARP_Core use).
bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

public plugin_cfg()
{
	// configs/h9_tts.cfg: the server's own settings, or a preset's (H9XASH\presets)
	new dir[96], file[160];
	get_configsdir(dir, charsmax(dir));
	formatex(file, charsmax(file), "%s/h9_tts.cfg", dir);
	if (file_exists(file))
	{
		server_cmd("exec %s", file);
		server_exec();
	}
	load_masked(dir);
}

public client_putinserver(id)
{
	if (id >= 1 && id <= MAX_PLAYERS)
	{
		g_last[id] = 0.0;
		g_credit[id] = float(TTS_LISTENER_BURST);
		g_credit_at[id] = 0.0;
		g_pref_variant[id] = 0;
		g_pref_depth[id] = 0;
		// a few seconds on, when the game is up, it is asked for its voice picks (h9_ttsvoice)
		if (g_msg && !is_user_bot(id))
		{
			set_task(3.0, "task_hello", id);
		}
	}
}

/// The H9Tts message with slot 0 and flag bit 1: this server has the plugin, send h9_ttsvoice. A game that does not know
/// the message leaves it unread; a game that does sends its picks only when it has been asked, so a server without the
/// plugin is never sent a command it does not have.
public task_hello(id)
{
	if (!g_msg || !is_user_connected(id) || is_user_bot(id))
	{
		return;
	}
	engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg, Float:{0.0, 0.0, 0.0}, id);
	write_byte(0);
	write_byte(0);
	write_byte(0);
	write_byte(2);
	write_string("");
	message_end();
}

/* ---- the gas-masked models ------------------------------------------------------------------- */

/// Reads TTS_MASK_FILE: one model name a line, anything after the name ignored, blank lines and lines
/// that start with // skipped. A name that ends in * stands for every model whose name starts so (repuheavy*), and a
/// name with ! before it takes that model out again, whatever else lists it.
load_masked(const dir[])
{
	TrieClear(g_masked);
	TrieClear(g_unmasked);
	g_mask_prefixes = 0;

	new path[160];
	formatex(path, charsmax(path), "%s/%s", dir, TTS_MASK_FILE);
	new f = fopen(path, "rt");
	if (!f)
	{
		log_amx("[TTS] %s is missing -- no model is gas-masked.", TTS_MASK_FILE);
		return;
	}

	new line[96], count = 0;
	while (!feof(f))
	{
		fgets(f, line, charsmax(line));
		new key[40], n = 0;
		new bool:wild = false, bool:out = false;
		for (new i = 0; line[i] && n < charsmax(key); i++)
		{
			new c = line[i];
			if (c >= 'A' && c <= 'Z')
			{
				c += 32;
			}
			if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')
			{
				key[n++] = c;
			}
			else if (n == 0 && (c == ' ' || c == '^t'))
			{
				continue;
			}
			else if (n == 0 && c == '!' && !out)
			{
				out = true;
			}
			else
			{
				wild = (c == '*' && n > 0);
				break;
			}
		}
		key[n] = 0;
		if (n > 0)
		{
			if (out)
			{
				TrieSetCell(g_unmasked, key, 1);
			}
			else if (wild)
			{
				if (g_mask_prefixes < TTS_MASK_PREFIXES)
				{
					copy(g_mask_prefix[g_mask_prefixes++], charsmax(g_mask_prefix[]), key);
				}
			}
			else
			{
				TrieSetCell(g_masked, key, 1);
			}
			count++;
		}
	}
	fclose(f);
	log_amx("[TTS] %d gas-masked model name(s) from %s.", count, TTS_MASK_FILE);
}

/// Whether a gas mask muffles the voice of a model (its lower-case folder name): listed by name or by the start of its name,
/// and not taken out by a ! line.
bool:is_masked(const key[])
{
	if (TrieKeyExists(g_unmasked, key))
	{
		return false;
	}
	if (TrieKeyExists(g_masked, key))
	{
		return true;
	}
	for (new i = 0; i < g_mask_prefixes; i++)
	{
		if (equal(key, g_mask_prefix[i], strlen(g_mask_prefix[i])))
		{
			return true;
		}
	}
	return false;
}

/* ---- what is said ---------------------------------------------------------------------------- */

public cmd_say(id)
{
	if (!g_msg || !get_pcvar_num(g_cv_on) || id < 1 || id > g_maxplayers)
	{
		return PLUGIN_CONTINUE;
	}

	new Float:now = get_gametime();
	if (now - g_last[id] < get_pcvar_float(g_cv_gap) || !may_speak(id))
	{
		return PLUGIN_CONTINUE;
	}

	new text[TTS_RAW_LEN];
	read_args(text, charsmax(text));
	remove_quotes(text);
	trim(text);

	// A command is not speech: a dot, a slash or a bang starts the plugins' commands, an @ is admin chat.
	if (!text[0] || text[0] == '.' || text[0] == '/' || text[0] == '!' || text[0] == '@')
	{
		return PLUGIN_CONTINUE;
	}
	if (!tts_clean(text))
	{
		return PLUGIN_CONTINUE;
	}

	new cmd[12];
	read_argv(0, cmd, charsmax(cmd));
	g_last[id] = now;
	speak_near(id, text, equal(cmd, "say_team") != 0);
	return PLUGIN_CONTINUE;
}

/// h9_texttospeech and h9_tts in a player's console. With no argument it prints the state: the server's switch, whether this
/// player's game can speak (the userinfo key _h9tts: cl_h9_tts is not 0 and the machine has a voice) and whether he hears his own
/// lines. With 0 or 1 (or off or on) an admin with the cvar flag switches h9_texttospeech.
public cmd_tts(id)
{
	if (read_argc() >= 2)
	{
		if (!(get_user_flags(id) & ADMIN_CVAR))
		{
			console_print(id, "[TTS] Only an admin can switch text to speech.");
			return PLUGIN_HANDLED;
		}
		new arg[8];
		read_argv(1, arg, charsmax(arg));
		new on = (equal(arg, "1") || equali(arg, "on")) ? 1 : 0;
		if (!on && !equal(arg, "0") && !equali(arg, "off"))
		{
			console_print(id, "[TTS] Say 1 (or on) to speak chat, 0 (or off) to stop.");
			return PLUGIN_HANDLED;
		}
		set_pcvar_num(g_cv_on, on);
		new name[32];
		get_user_name(id, name, charsmax(name));
		log_amx("[TTS] %s set h9_texttospeech to %d.", name, on);
	}

	new v[4];
	get_user_info(id, "_h9tts", v, charsmax(v));
	console_print(id, "[TTS] Server: text to speech is %s (h9_texttospeech %d).", get_pcvar_num(g_cv_on) ? "ON" : "OFF", get_pcvar_num(g_cv_on));
	console_print(id, "[TTS] Your game: %s (_h9tts %s). It speaks while cl_h9_tts is not 0 and this machine has a voice.", v[0] == '1' ? "can speak" : "will not speak", v[0] ? v : "0");
	new kinds[4][] = { "a man's", "a woman's", "a Mech's", "a bot's" };
	new vflags, model[40];
	new vkind = voice_of(id, vflags);
	get_user_info(id, "model", model, charsmax(model));
	console_print(id, "[TTS] Your model %s speaks with %s voice%s (variant %d, depth %d).", model, (vflags & TTS_F_DROID) ? "a droid's" : kinds[vkind],
		(vflags & TTS_F_MUFFLED) ? ", muffled by a gas mask" : ", not muffled (the model is not on h9_tts_gasmask.cfg)", g_pref_variant[id], g_pref_depth[id]);
	console_print(id, "[TTS] You hear your own lines: %s (h9_tts_self %d).", get_pcvar_num(g_cv_self) ? "yes" : "no", get_pcvar_num(g_cv_self));
	if (get_pcvar_num(g_cv_global) && !g_roleplay)
	{
		console_print(id, "[TTS] Global (h9_tts_global 1): a line is spoken to every player with text to speech, wherever he is, at full volume (say_team: his team).");
	}
	else
	{
		console_print(id, "[TTS] A line is spoken to living players within %d units of the speaker%s.", get_pcvar_num(g_cv_range),
			(get_pcvar_num(g_cv_global) && g_roleplay) ? " (h9_tts_global is 1, but on a roleplay map the talk area decides, so it does nothing here)" : "");
	}
	return PLUGIN_HANDLED;
}

/// h9_ttsvoice [variant] [depth] from a player's game: the variant (0 leaves the voice to each listener; 1 and up is a
/// voice of the kind of his model, picked the same way on every machine that has that many) and the depth (-10 deeper to
/// 10 higher) others hear him with. With nothing after it, it prints what the server has for him.
public cmd_ttsvoice(id)
{
	if (id < 1 || id > MAX_PLAYERS)
	{
		return PLUGIN_HANDLED;
	}
	new argc = read_argc();
	if (argc >= 2)
	{
		new arg[12];
		read_argv(1, arg, charsmax(arg));
		g_pref_variant[id] = clamp(str_to_num(arg), 0, TTS_VARIANT_MAX);
	}
	if (argc >= 3)
	{
		new arg[12];
		read_argv(2, arg, charsmax(arg));
		g_pref_depth[id] = clamp(str_to_num(arg), -TTS_DEPTH_MAX, TTS_DEPTH_MAX);
	}
	if (argc < 2)
	{
		console_print(id, "[TTS] Others hear you with voice variant %d, depth %d (cl_h9_tts_myvoice, cl_h9_tts_mydepth).", g_pref_variant[id], g_pref_depth[id]);
	}
	return PLUGIN_HANDLED;
}

/// Whether this player's chat is spoken at all: he is alive, his account is not muted (h9_presence, when
/// it is loaded), and he is drawn -- not hidden with EF_NODRAW or made fully transparent, as an
/// eliminated player or a spectator is.
bool:may_speak(id)
{
	if (!is_user_alive(id))
	{
		return false;
	}
	if (g_have_presence && h9p_muted(id))
	{
		return false;
	}
	if (pev(id, pev_effects) & TTS_EF_NODRAW)
	{
		return false;
	}
	new Float:amt;
	pev(id, pev_renderamt, amt);
	return !(pev(id, pev_rendermode) != 0 && amt <= 1.0);
}

/// Makes the line fit for a voice, in place: control characters are spaces, a run of spaces is one, the
/// ends are trimmed, and it is cut to h9_tts_maxchars -- at a space when one is near the end, never inside
/// a multi-byte character. False when there is nothing to say: no letter, digit or non-ASCII character.
bool:tts_clean(text[])
{
	new maxc = clamp(get_pcvar_num(g_cv_maxchars), 8, TTS_MAX_LIMIT);

	new n = 0, speakable = 0;
	new bool:space = true;
	for (new i = 0; text[i] && n < TTS_RAW_LEN - 1; i++)
	{
		new c = text[i];
		if ((c >= 0 && c < 32) || c == 127)
		{
			c = ' ';
		}
		if (c == ' ')
		{
			if (!space)
			{
				text[n++] = ' ';
				space = true;
			}
			continue;
		}
		space = false;
		text[n++] = c;
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c > 127 || c < 0)
		{
			speakable++;
		}
	}
	while (n > 0 && text[n - 1] == ' ')
	{
		n--;
	}

	if (n > maxc)
	{
		new end = maxc;
		new at = end;
		while (at > 0 && at > end - TTS_CUT_BACK && text[at] != ' ')
		{
			at--;
		}
		if (at > 0 && text[at] == ' ')
		{
			end = at;
		}
		else
		{
			while (end > 0 && (text[end] & 0xC0) == 0x80)
			{
				end--;
			}
		}
		while (end > 0 && text[end - 1] == ' ')
		{
			end--;
		}
		n = end;
	}
	text[n] = 0;
	return speakable > 0 && n > 0;
}

/// Whether a model name has any of these words in it.
bool:has_word(const name[], const words[][], count)
{
	for (new i = 0; i < count; i++)
	{
		if (contain(name, words[i]) != -1)
		{
			return true;
		}
	}
	return false;
}

/// The voice of a player, from his model's name alone, and in flags whether a gas mask muffles it.
voice_of(id, &flags)
{
	flags = 0;

	new model[40], key[40];
	get_user_info(id, "model", model, charsmax(model));
	new n = 0;
	for (new i = 0; model[i] && n < charsmax(key); i++)
	{
		new c = model[i];
		if (c >= 'A' && c <= 'Z')
		{
			c += 32;
		}
		key[n++] = c;
	}
	key[n] = 0;

	new voice = TTS_MAN;
	if (has_word(key, g_mech_words, sizeof g_mech_words))
	{
		voice = TTS_MECH;
	}
	else if (has_word(key, g_bot_words, sizeof g_bot_words))
	{
		voice = TTS_BOT;
		if (has_word(key, g_droid_words, sizeof g_droid_words))
		{
			flags |= TTS_F_DROID;
		}
	}
	else if (has_word(key, g_woman_words, sizeof g_woman_words))
	{
		voice = TTS_WOMAN;
	}

	// A mask muffles a man's or a woman's voice; a Mech and a bot are what they are.
	if (voice <= TTS_WOMAN && is_masked(key))
	{
		flags |= TTS_F_MUFFLED;
	}
	return voice;
}

/// Where the speaker is, as the listener's ears have it: -100 all in the left ear, 100 all in the right, 0 in the middle, from
/// the listener's yaw and the line between them (walls ignored, as the range is). Close up it fades to the middle, so a speaker
/// at one's elbow is not thrown to a side for turning a little.
pan_of(const Float:speaker[3], const Float:listener[3], const Float:view[3], Float:dist)
{
	if (dist < 24.0)
	{
		return 0;
	}
	new Float:rel = floatatan2(speaker[1] - listener[1], speaker[0] - listener[0], degrees) - view[1];
	while (rel > 180.0)
	{
		rel -= 360.0;
	}
	while (rel < -180.0)
	{
		rel += 360.0;
	}
	new Float:closeness = dist / 160.0;
	if (closeness > 1.0)
	{
		closeness = 1.0;
	}
	return floatround(-floatsin(rel, degrees) * closeness * 100.0);
}

/// Whether a player's game speaks: _h9tts is 1 in his userinfo.
bool:hears(id)
{
	new v[4];
	get_user_info(id, "_h9tts", v, charsmax(v));
	return v[0] == '1';
}

/// Whether this listener may be sent another line now, and takes one of his credits when he may: he may be sent
/// TTS_LISTENER_BURST lines at once, then one every TTS_LISTENER_GAP seconds, from all speakers together. Speakers
/// that talk at the same moment are all heard (up to the burst); the reliable channel is spared on a busy server.
bool:listener_credit(p, Float:now)
{
	new Float:since = now - g_credit_at[p];
	if (since < 0.0)
	{
		since = 0.0;
	}
	new Float:credit = g_credit[p] + since / TTS_LISTENER_GAP;
	if (credit > float(TTS_LISTENER_BURST))
	{
		credit = float(TTS_LISTENER_BURST);
	}
	g_credit_at[p] = now;
	if (credit < 1.0)
	{
		g_credit[p] = credit;
		return false;
	}
	g_credit[p] = credit - 1.0;
	return true;
}

/// Sends the line to its listeners. Local (h9_tts_global 0): the living humans within h9_tts_range of the speaker, at full
/// volume within a quarter of it and fading to nothing at the range, placed in their ears by where the speaker is. Global
/// (h9_tts_global 1, and not a roleplay map): every connected human whose game speaks, wherever he is, alive or not, at full
/// volume and from no direction, flagged TTS_F_GLOBAL; a roleplay map is left out because ARP_TalkArea decides who sees a
/// line there and global must not reach further than the text. For say_team only a player of the speaker's team, in both.
/// Reliable, because on a big map the engine drops an unreliable message together with the datagram it cannot fit
/// ("Datagram overflowed" in ts\logs\h9_overflow.log), and every message a roleplay map sends ends up there; the reliable
/// channel is spared by listener_credit. After the words come the speaker's variant and depth (h9_ttsvoice) and where he is in
/// the listener's ears (the pan), which a game that does not know them leaves unread. Begun with fakemeta's
/// EngFunc_MessageBegin, as every plugin message is (Metamod-R records only the game DLL's own).
speak_near(id, const text[], bool:team_only)
{
	new flags;
	new voice = voice_of(id, flags);
	new detail = (flags & TTS_F_DROID) ? 1 : 0;
	flags &= ~TTS_F_DROID;

	new bool:global = get_pcvar_num(g_cv_global) != 0 && !g_roleplay;
	if (global)
	{
		flags |= TTS_F_GLOBAL;
	}

	new Float:range = get_pcvar_float(g_cv_range);
	if (range < 50.0)
	{
		range = 50.0;
	}
	new Float:close = range * 0.25;

	new Float:org[3], Float:there[3];
	pev(id, pev_origin, org);
	new team = get_user_team(id);

	for (new p = 1; p <= g_maxplayers; p++)
	{
		if ((p == id && !get_pcvar_num(g_cv_self)) || !is_user_connected(p) || is_user_bot(p))
		{
			continue;
		}
		if (!global && !is_user_alive(p))
		{
			continue;
		}
		if (team_only && get_user_team(p) != team)
		{
			continue;
		}
		if (!hears(p))
		{
			continue;
		}

		new vol = 100;
		new pan = 0;
		if (!global)
		{
			pev(p, pev_origin, there);
			new Float:dist = get_distance_f(org, there);
			if (dist >= range)
			{
				continue;
			}
			if (dist > close)
			{
				vol = floatround(100.0 * (1.0 - (dist - close) / (range - close)));
			}
			if (vol < 4)
			{
				continue;
			}
			if (p != id)
			{
				new Float:view[3];
				pev(p, pev_v_angle, view);
				pan = pan_of(org, there, view, dist);
			}
		}

		if (!listener_credit(p, get_gametime()))
		{
			continue;
		}
		engfunc(EngFunc_MessageBegin, MSG_ONE, g_msg, Float:{0.0, 0.0, 0.0}, p);
		write_byte(id);
		write_byte(voice);
		write_byte(vol);
		write_byte(flags);
		write_string(text);
		write_byte(g_pref_variant[id]);
		write_char(g_pref_depth[id]);
		write_char(pan);
		write_byte(detail);
		message_end();
	}
}
