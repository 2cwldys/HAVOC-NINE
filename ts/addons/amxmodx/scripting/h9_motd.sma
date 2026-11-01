/*
 * h9_motd.sma -- the splash MOTD: a picture or a web page in place of TS's text MOTD
 *
 * OFF BY DEFAULT. With h9_motd "text" (the default) the plugin does nothing and players get TS's
 * own text MOTD (motd.txt), as on any server. A host sets h9_motd "image" or "page" and the
 * address in h9_motd_url, in addons/amxmodx/configs/h9_motd.cfg (executed when the plugin loads),
 * in amxx.cfg, or for one map in mapconfigs/<map>.cfg, which h9_autoconfig runs after the plugins'
 * own configs, so a map can turn it on, off or point it elsewhere. docs\HTTP_SERVER_MOTD.txt is
 * the host's guide, docs\H9_MOTD.txt the whole picture.
 *
 * CVARS (read when each player joins, so a change takes effect for the next one)
 *   h9_motd        "text"     text: TS's text MOTD. image: a picture. page: a web page.
 *   h9_motd_url    ""         https address of the picture (image) or of the page (page)
 *   h9_motd_image  ""         page only: a picture shown in the page's place by H9XASH, which
 *                             draws no web pages (it shows the text MOTD there when empty)
 *   h9_motd_link   ""         image only: a web page the OPEN PAGE button offers
 *   h9_motd_show   "connect"  connect: once a connection. map: at every map.
 *
 * HOW IT GETS THERE. TS sends its text MOTD from InitHUD, which runs on the player's first
 * PreThink of each map. This plugin sends the H9Motd user message from a pre hook on that same
 * PreThink, so it reaches the client first. H9XASH's engine (engine-h9-motd.patch) and the web
 * client take H9Motd, hold the text while the splash loads, then show the splash and drop the
 * text, or show the text when the splash cannot be shown. The message goes only to clients with
 * the h9_clientid userinfo key, which H9XASH and the web client send: a stock client never gets a
 * message it does not know, and keeps TS's text MOTD. The player's cl_h9_motd 0 does the same
 * for one player. The motd command shows the splash again (asked), whatever h9_motd_show says.
 *
 * THE MESSAGE. One info string, sent in parts of MOTD_PART characters (a byte, 1 on the last
 * part, then a string), as TS sends its text: v, type, show, image, page, title (the hostname)
 * and asked. A part stays well under GoldSrc's 192-byte user message limit.
 *
 * THE ADDRESSES. https only, a host name with a dot and a letter (no IP address, no localhost,
 * no user name before the host), no spaces, quotes or backslashes, at most 255 characters; the
 * picture's address needs a path. The engine checks the same and refuses anything else; this
 * plugin checks first so a host sees why in the AMXX log, and then sends nothing (the text MOTD).
 *
 * Written to the same rules as ts_matchmode.sma: explicit tags, braces on every block, and no
 * backslash in a string (the info string's separator is written as the number 92).
 */

#include <amxmodx>
#include <amxmisc>
#include <fakemeta>

#pragma dynamic 8192

#define PLUGIN  "H9 Splash MOTD"
#define VERSION "1.0"
#define AUTHOR  "HAVOC 9"

#define MOTD_URL_MAX   256    // an address, its terminator included: the engine's limit
#define MOTD_INFO_MAX  1024   // the whole info string: the engine's limit
#define MOTD_PART      150    // characters in one H9Motd part
#define MOTD_ASK_GAP   2.0    // seconds between two motd commands from one player
#define TASK_UNHOOK    7310

new g_cvMode;
new g_cvUrl;
new g_cvImage;
new g_cvLink;
new g_cvShow;
new g_msgH9Motd;
new g_fwPreThink;
new bool:g_pending[MAX_PLAYERS + 1];
new Float:g_askedAt[MAX_PLAYERS + 1];
new g_warned[64];

public plugin_precache()
{
	// registered while the map loads, so every client gets it in the list sent at connect
	g_msgH9Motd = engfunc(EngFunc_RegUserMsg, "H9Motd", -1);
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_cvMode  = create_cvar("h9_motd", "text", FCVAR_NONE, "The splash MOTD: text (TS's own text MOTD), image or page");
	g_cvUrl   = create_cvar("h9_motd_url", "", FCVAR_NONE, "https address of the picture (image) or of the web page (page)");
	g_cvImage = create_cvar("h9_motd_image", "", FCVAR_NONE, "page only: a picture H9XASH shows in the page's place");
	g_cvLink  = create_cvar("h9_motd_link", "", FCVAR_NONE, "image only: a web page the OPEN PAGE button offers");
	g_cvShow  = create_cvar("h9_motd_show", "connect", FCVAR_NONE, "connect: once a connection; map: at every map");

	register_clcmd("motd", "cmd_motd");
}

public plugin_cfg()
{
	// AMXX only runs amxx.cfg by itself: a plugin's own cfg is run by the plugin
	new cfgdir[64], cfgfile[160];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(cfgfile, charsmax(cfgfile), "%s/h9_motd.cfg", cfgdir);

	if (file_exists(cfgfile))
	{
		server_cmd("exec %s", cfgfile);
		server_exec();
	}
}

public client_putinserver(id)
{
	g_pending[id] = false;
	g_askedAt[id] = 0.0;

	if (is_user_bot(id) || is_user_hltv(id) || !splash_client(id))
	{
		return;
	}

	new info[MOTD_INFO_MAX];

	if (!build_info(info, charsmax(info), false))
	{
		return;
	}

	// sent on the player's first PreThink: a user message to a client that is not in the game
	// yet is dropped by the engine, and TS's text MOTD follows in that same PreThink
	g_pending[id] = true;

	if (!g_fwPreThink)
	{
		g_fwPreThink = register_forward(FM_PlayerPreThink, "fw_prethink", 0);
	}
}

public client_disconnected(id)
{
	g_pending[id] = false;
}

public fw_prethink(id)
{
	if (id < 1 || id > MAX_PLAYERS || !g_pending[id])
	{
		return FMRES_IGNORED;
	}

	g_pending[id] = false;
	send_splash(id, false);

	// nobody else waiting: the hook goes, outside its own call
	if (!any_pending() && !task_exists(TASK_UNHOOK))
	{
		set_task(0.1, "task_unhook", TASK_UNHOOK);
	}

	return FMRES_IGNORED;
}

public task_unhook()
{
	if (g_fwPreThink && !any_pending())
	{
		unregister_forward(FM_PlayerPreThink, g_fwPreThink, 0);
		g_fwPreThink = 0;
	}
}

// The player typed motd: TS sends its text again, and this sends the splash ahead of it, shown
// whatever h9_motd_show says. Twice within MOTD_ASK_GAP seconds and the second does nothing.
public cmd_motd(id)
{
	if (!splash_client(id))
	{
		return PLUGIN_CONTINUE;
	}

	new info[MOTD_INFO_MAX];

	if (!build_info(info, charsmax(info), true))
	{
		return PLUGIN_CONTINUE;
	}

	new Float:now = get_gametime();

	if (g_askedAt[id] > 0.0 && now - g_askedAt[id] < MOTD_ASK_GAP && now >= g_askedAt[id])
	{
		return PLUGIN_HANDLED;
	}

	g_askedAt[id] = now;
	send_info(id, info, strlen(info));
	return PLUGIN_CONTINUE;
}

bool:any_pending()
{
	for (new i = 1; i <= MAX_PLAYERS; i++)
	{
		if (g_pending[i])
		{
			return true;
		}
	}
	return false;
}

// H9XASH and the web client send h9_clientid; nothing else can show a splash
bool:splash_client(id)
{
	if (g_msgH9Motd <= 0 || !is_user_connected(id) || is_user_bot(id))
	{
		return false;
	}

	new clientid[8];
	get_user_info(id, "h9_clientid", clientid, charsmax(clientid));
	return clientid[0] != EOS;
}

send_splash(id, bool:asked)
{
	new info[MOTD_INFO_MAX];
	new len = build_info(info, charsmax(info), asked);

	if (len)
	{
		send_info(id, info, len);
	}
}

send_info(id, const info[], len)
{
	if (!len || !is_user_connected(id))
	{
		return;
	}

	new part[MOTD_PART + 1];

	for (new at = 0; at < len; at += MOTD_PART)
	{
		copy(part, MOTD_PART, info[at]);

		message_begin(MSG_ONE, g_msgH9Motd, _, id);
		write_byte((at + MOTD_PART >= len) ? 1 : 0);
		write_string(part);
		message_end();
	}
}

// The info string for the cvars as they stand; 0 when the splash is off or an address is refused
build_info(info[], maxlen, bool:asked)
{
	new mode[16], show[16];
	get_pcvar_string(g_cvMode, mode, charsmax(mode));
	trim(mode);

	new bool:is_page;

	if (equali(mode, "page"))
	{
		is_page = true;
	}
	else if (equali(mode, "image"))
	{
		is_page = false;
	}
	else
	{
		if (!equali(mode, "text") && mode[0] != EOS)
		{
			warn_once(0, "h9_motd is ^"%s^": it must be text, image or page; the text MOTD is shown", mode);
		}
		return 0;
	}

	new url[MOTD_URL_MAX + 8], extra[MOTD_URL_MAX + 8];
	new image[MOTD_URL_MAX], page[MOTD_URL_MAX];
	new why[96];

	get_pcvar_string(g_cvUrl, url, charsmax(url));
	trim(url);

	if (!check_url(url, !is_page, why, charsmax(why)))
	{
		warn_once(1, "h9_motd_url refused (%s); the text MOTD is shown", why);
		return 0;
	}

	if (is_page)
	{
		copy(page, charsmax(page), url);
		get_pcvar_string(g_cvImage, extra, charsmax(extra));
		trim(extra);

		if (extra[0] != EOS)
		{
			if (check_url(extra, true, why, charsmax(why)))
			{
				copy(image, charsmax(image), extra);
			}
			else
			{
				warn_once(2, "h9_motd_image refused (%s); H9XASH shows the text MOTD for the page", why);
			}
		}
	}
	else
	{
		copy(image, charsmax(image), url);
		get_pcvar_string(g_cvLink, extra, charsmax(extra));
		trim(extra);

		if (extra[0] != EOS)
		{
			if (check_url(extra, false, why, charsmax(why)))
			{
				copy(page, charsmax(page), extra);
			}
			else
			{
				warn_once(3, "h9_motd_link refused (%s); the picture has no OPEN PAGE button", why);
			}
		}
	}

	get_pcvar_string(g_cvShow, show, charsmax(show));
	trim(show);

	if (!equali(show, "map"))
	{
		if (!equali(show, "connect"))
		{
			warn_once(4, "h9_motd_show is ^"%s^": connect or map; connect is used", show);
		}
		copy(show, charsmax(show), "connect");
	}
	else
	{
		copy(show, charsmax(show), "map");
	}

	new title[64];
	get_cvar_string("hostname", title, charsmax(title));
	clean_title(title);

	new len = 0;
	len += add_kv(info[len], maxlen - len, "v", "1");
	len += add_kv(info[len], maxlen - len, "type", is_page ? "page" : "image");
	len += add_kv(info[len], maxlen - len, "show", show);
	len += add_kv(info[len], maxlen - len, "image", image);
	len += add_kv(info[len], maxlen - len, "page", page);
	len += add_kv(info[len], maxlen - len, "title", title);

	if (asked)
	{
		len += add_kv(info[len], maxlen - len, "asked", "1");
	}

	return len;
}

// one key and value of the info string, each after the separator (92, a backslash)
add_kv(dest[], maxlen, const key[], const value[])
{
	if (maxlen <= 0)
	{
		return 0;
	}
	return formatex(dest, maxlen, "%c%s%c%s", 92, key, 92, value);
}

// The server's name for the panel's title: printable ASCII, no backslash or quote
clean_title(title[])
{
	for (new i = 0; title[i] != EOS; i++)
	{
		if (title[i] < 32 || title[i] > 126 || title[i] == 92 || title[i] == '"' || title[i] == '^^')
		{
			title[i] = ' ';
		}
	}
	trim(title);
}

// The engine's rules for an address (see the comment at the top); why gets the reason when false
bool:check_url(const url[], bool:need_path, why[], whylen)
{
	new len = strlen(url);

	if (len == 0)
	{
		copy(why, whylen, "it is empty");
		return false;
	}

	if (len >= MOTD_URL_MAX)
	{
		formatex(why, whylen, "longer than %d characters", MOTD_URL_MAX - 1);
		return false;
	}

	if (len <= 8 || !equali(url, "https://", 8))
	{
		copy(why, whylen, "it must start with https://");
		return false;
	}

	for (new i = 0; i < len; i++)
	{
		new c = url[i];

		if (c <= ' ' || c >= 127 || c == 92 || c == '"' || c == 39 || c == '<' || c == '>'
			|| c == '^^' || c == '`' || c == '{' || c == '|' || c == '}')
		{
			copy(why, whylen, "a space, quote, backslash or one of <>^^`{|} in it");
			return false;
		}
	}

	new i = 8, hostlen = 0;
	new bool:letter = false, bool:dot = false;
	new last = 0;

	while (i < len && url[i] != '/' && url[i] != '?' && url[i] != '#' && url[i] != ':')
	{
		new c = url[i];

		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
		{
			letter = true;
		}
		else if (c == '.')
		{
			if (hostlen == 0 || last == '.')
			{
				copy(why, whylen, "the host name is not valid");
				return false;
			}
			dot = true;
		}
		else if (!((c >= '0' && c <= '9') || c == '-'))
		{
			copy(why, whylen, "the host must be a plain name: letters, digits, dots and dashes, no user name");
			return false;
		}

		last = c;
		hostlen++;
		i++;
	}

	if (hostlen == 0 || !dot || last == '.')
	{
		copy(why, whylen, "the host must be a name with a dot, such as example.com");
		return false;
	}

	if (!letter)
	{
		copy(why, whylen, "the host must be a name, not an IP address");
		return false;
	}

	if (i < len && url[i] == ':')
	{
		new port = 0, digits = 0;
		i++;

		while (i < len && url[i] >= '0' && url[i] <= '9' && digits < 6)
		{
			port = port * 10 + (url[i] - '0');
			digits++;
			i++;
		}

		if (digits == 0 || port < 1 || port > 65535 || (i < len && url[i] != '/' && url[i] != '?' && url[i] != '#'))
		{
			copy(why, whylen, "the port is not valid");
			return false;
		}
	}

	if (need_path)
	{
		if (i >= len || url[i] != '/')
		{
			copy(why, whylen, "a picture's address needs a path, such as https://example.com/motd.png");
			return false;
		}

		if (contain(url, "#") != -1)
		{
			copy(why, whylen, "a picture's address may not have a # part");
			return false;
		}
	}

	return true;
}

// Logged once a map for each kind of problem, so a wrong cvar does not fill the log
warn_once(slot, const fmt[], any:...)
{
	if (slot < 0 || slot >= sizeof(g_warned) || g_warned[slot])
	{
		return;
	}

	g_warned[slot] = 1;

	new msg[256];
	vformat(msg, charsmax(msg), fmt, 3);
	log_amx("[H9 MOTD] %s", msg);
}
