/*
 * h9_msgstats -- what the server sends its players, counted.
 *
 * The engine's "Datagram overflowed for <name>" means one client's frame (the entities it can see,
 * plus the unreliable user messages and temp entities of that frame) passed the 16384 bytes of
 * MAX_DATAGRAM. This plugin shows which of the two is filling it:
 *
 *   MESSAGES. Every message the game or a plugin begins is counted by name (a temp entity by its
 *   TE_ type) with its size and its destination, once a second, for the whole map and for a
 *   sampling window. A message is sized from the writes between its begin and its end plus two
 *   bytes of framing; a message to everyone is counted once for each human in the game, and one
 *   to a PVS or PAS for each human too, which is the most it can reach.
 *
 *   ENTITIES. While a window runs, every entity the game DLL puts into a client's update
 *   (AddToFullPack) is counted per client and per update, split into players and brush models,
 *   and priced the way the engine prices an entity new to a client (about 10 bytes; a player
 *   about 30). That price is what a full update costs: a client whose delta base was lost is sent
 *   every entity in view at once, and the whole frame is dropped when it passes 16384.
 *
 * h9_msgstats [seconds] runs a window (60 by default, 5 to 600) and then prints the report to the
 * console that asked for it and to the AMX Mod X log. h9_msgstats 0 prints what has been counted
 * since the map began, at once. The message counting is a few cheap forwards; the entity counting
 * exists only while a window runs. h9_msgstats_on 0 takes it all off.
 */
#include <amxmodx>
#include <amxmisc>
#include <fakemeta>

#define PLUGIN  "H9 Message Stats"
#define VERSION "1.0"
#define AUTHOR  "H9"

#define MS_SLOTS        (MAX_PLAYERS + 1)
#define MS_IDS          256
#define MS_TE           128
#define MS_KEYS         (MS_IDS + MS_TE)
#define MS_TOP          15
#define MS_CLASSES      40
#define MS_TASK         61200

#define MS_SVC_TEMPENTITY  23
#define MS_USERMSG_FIRST   64
#define MS_SOLID_BSP       4
#define MS_FRAME_LIMIT     16384

// what the engine spends on an entity new to a client: 19 header bits, 54 field flags and the
// fields that differ from its baseline (net_encode.c, delta.lst), rounded up; a player's state
// carries far more
#define MS_BYTES_ENTITY    10
#define MS_BYTES_PLAYER    30
#define MS_BYTES_FRAME     200

#define MS_FW_COUNT     10

// the message counters of one second, of the map, and of the sampling window
new g_c_msgs[MS_KEYS], g_c_bytes[MS_KEYS], g_c_estu[MS_KEYS], g_c_estr[MS_KEYS];
new g_t_msgs[MS_KEYS], g_t_bytes[MS_KEYS], g_t_estu[MS_KEYS], g_t_estr[MS_KEYS];
new g_w_msgs[MS_KEYS], g_w_bytes[MS_KEYS], g_w_estu[MS_KEYS], g_w_estr[MS_KEYS], g_w_peak[MS_KEYS];

// the message being written
new bool:g_in_msg;
new g_m_type, g_m_dest, g_m_bytes, g_m_te, g_m_writes;

// frames, seconds
new g_frames_c, g_frames_t, g_frames_w, g_seconds_t, g_seconds_w;
new g_w_sec_peak, g_w_sec_sum;
new g_humans, g_bots;

// the sampling window
new bool:g_win;
new Float:g_w_end;
new g_w_seconds;
new g_req;

// entities per client update, from AddToFullPack
new g_fw_afp = -1;
new g_afp_n[MS_SLOTS], g_afp_pl[MS_SLOTS], g_afp_bsp[MS_SLOTS];
new g_a_sends[MS_SLOTS], g_a_sum[MS_SLOTS], g_a_max[MS_SLOTS], g_a_pl[MS_SLOTS], g_a_bsp[MS_SLOTS];
new g_a_est_max[MS_SLOTS], g_a_over[MS_SLOTS];

new g_fw[MS_FW_COUNT] = {-1, ...};
new bool:g_hooked;

new g_cv_on;
new g_maxplayers;

new g_idname[MS_IDS][24];

new const g_known[][] = {
	"TextMsg", "SayText", "ScoreInfo", "TeamInfo", "TeamScore", "DeathMsg", "Damage", "Health", "Battery",
	"CurWeapon", "AmmoX", "AmmoPickup", "WeapPickup", "ItemPickup", "HideWeapon", "ResetHUD", "InitHUD",
	"GameTitle", "ScreenFade", "ScreenShake", "SetFOV", "ShowMenu", "VGUIMenu", "MOTD", "ServerName",
	"StatusText", "StatusValue", "StatusIcon", "BarTime", "BarTime2", "Flashlight", "Crosshair", "Concuss",
	"Train", "Geiger", "SendAudio", "HudText", "WeaponList", "Fog", "Brass", "ShieldRic", "ReloadSound",
	"Spectator", "Logo", "SelAmmo", "ClipInfo", "WeaponInfo", "ActItems", "CustomWP", "GameMode", "KFuPower",
	"NextStunt", "Objective", "PlInfo", "PTakeDam", "PwUp", "PwUpTime", "RoundTime", "ShowObj", "SrvSett",
	"TeamNames", "TSArmor", "TSBTime", "TSCash", "TSFade", "TSFlag", "TSFrags", "TSHealth", "TSHVoice",
	"TSMBlur", "TSMessage", "TSPAward", "TSPSys", "TSSlowMo", "TSSpace", "TSState", "Wires", "WStatus",
	"H9Account", "H9Assists", "H9Avatar", "H9Board", "H9Class", "H9Kills", "H9Level", "H9Link", "H9Lives",
	"H9Motd", "H9Pool", "H9Typing", "H9Vgui", "H9Mark", "H9Marks", "H9Presence", "H9Server", "H9Community",
	"ARP_Hud", "ARPHud"
};

new const g_svc_code[] = { 8, 9, 10, 23, 29, 30, 32, 35, 37, 38, 39, 51 };
new const g_svc_name[][] = {
	"svc_print", "svc_stufftext", "svc_setangle", "SVC_TEMPENTITY", "svc_spawnstaticsound", "svc_intermission",
	"svc_cdtrack", "svc_weaponanim", "svc_roomtype", "svc_addangle", "svc_newusermsg", "svc_director"
};

new const g_te_code[] = {
	0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31,
	99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
	121, 122, 123, 124, 125, 126, 127
};
new const g_te_name[][] = {
	"BEAMPOINTS", "BEAMENTPOINT", "GUNSHOT", "EXPLOSION", "TAREXPLOSION", "SMOKE", "TRACER", "LIGHTNING", "BEAMENTS",
	"SPARKS", "LAVASPLASH", "TELEPORT", "EXPLOSION2", "BSPDECAL", "IMPLOSION", "SPRITETRAIL", "SPRITE", "BEAMSPRITE",
	"BEAMTORUS", "BEAMDISK", "BEAMCYLINDER", "BEAMFOLLOW", "GLOWSPRITE", "BEAMRING", "STREAK_SPLASH", "DLIGHT", "ELIGHT",
	"TEXTMESSAGE", "LINE", "BOX", "KILLBEAM", "LARGEFUNNEL", "BLOODSTREAM", "SHOWLINE", "BLOOD", "DECAL", "FIZZ",
	"MODEL", "EXPLODEMODEL", "BREAKMODEL", "GUNSHOTDECAL", "SPRITE_SPRAY", "ARMOR_RICOCHET", "PLAYERDECAL", "BUBBLES",
	"BUBBLETRAIL", "BLOODSPRITE", "WORLDDECAL", "WORLDDECALHIGH", "DECALHIGH", "PROJECTILE", "SPRAY", "PLAYERSPRITES",
	"PARTICLEBURST", "FIREFIELD", "PLAYERATTACHMENT", "KILLPLAYERATTACHMENTS", "MULTIGUNSHOT", "USERTRACER"
};

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);

	g_maxplayers = get_maxplayers();
	g_cv_on = register_cvar("h9_msgstats_on", "1");

	register_concmd("h9_msgstats", "cmd_msgstats", ADMIN_CFG, "[seconds] - count the messages and entities sent to players for a while, then print the report; 0: print the map's totals now");

	ms_resolve();
	set_task(1.0, "task_ms_tick", MS_TASK, "", 0, "b");
	register_forward(FM_StartFrame, "fw_startframe_post", 1);
	ms_hooks(get_pcvar_num(g_cv_on) != 0);
}

/* ---- the hooks ------------------------------------------------------------------------------ */

ms_hooks(bool:on)
{
	if (on == g_hooked)
	{
		return;
	}
	g_hooked = on;
	if (on)
	{
		g_fw[0] = register_forward(FM_MessageBegin, "fw_msg_begin");
		g_fw[1] = register_forward(FM_MessageEnd, "fw_msg_end");
		g_fw[2] = register_forward(FM_WriteByte, "fw_w_byte");
		g_fw[3] = register_forward(FM_WriteChar, "fw_w_1");
		g_fw[4] = register_forward(FM_WriteShort, "fw_w_2");
		g_fw[5] = register_forward(FM_WriteLong, "fw_w_4");
		g_fw[6] = register_forward(FM_WriteAngle, "fw_w_angle");
		g_fw[7] = register_forward(FM_WriteCoord, "fw_w_coord");
		g_fw[8] = register_forward(FM_WriteString, "fw_w_string");
		g_fw[9] = register_forward(FM_WriteEntity, "fw_w_entity");
		return;
	}
	new const types[MS_FW_COUNT] = {
		FM_MessageBegin, FM_MessageEnd, FM_WriteByte, FM_WriteChar, FM_WriteShort, FM_WriteLong,
		FM_WriteAngle, FM_WriteCoord, FM_WriteString, FM_WriteEntity
	};
	for (new i = 0; i < MS_FW_COUNT; i++)
	{
		if (g_fw[i] != -1)
		{
			unregister_forward(types[i], g_fw[i]);
			g_fw[i] = -1;
		}
	}
	g_in_msg = false;
}

public fw_msg_begin(dest, type, const Float:origin[3], ent)
{
	if (g_in_msg)
	{
		ms_commit();
	}
	g_in_msg = true;
	g_m_dest = dest;
	g_m_type = type;
	g_m_bytes = (type >= MS_USERMSG_FIRST) ? 2 : 1;
	g_m_te = -1;
	g_m_writes = 0;
	return FMRES_IGNORED;
}

public fw_msg_end()
{
	if (g_in_msg)
	{
		ms_commit();
	}
	return FMRES_IGNORED;
}

public fw_w_byte(value)
{
	if (g_in_msg)
	{
		if (g_m_writes == 0 && g_m_type == MS_SVC_TEMPENTITY)
		{
			g_m_te = value & (MS_TE - 1);
		}
		g_m_writes++;
		g_m_bytes += 1;
	}
	return FMRES_IGNORED;
}

public fw_w_1(value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 1;
	}
	return FMRES_IGNORED;
}

public fw_w_2(value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 2;
	}
	return FMRES_IGNORED;
}

public fw_w_4(value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 4;
	}
	return FMRES_IGNORED;
}

public fw_w_angle(Float:value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 1;
	}
	return FMRES_IGNORED;
}

public fw_w_coord(Float:value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 2;
	}
	return FMRES_IGNORED;
}

public fw_w_string(const text[])
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += strlen(text) + 1;
	}
	return FMRES_IGNORED;
}

public fw_w_entity(value)
{
	if (g_in_msg)
	{
		g_m_writes++;
		g_m_bytes += 2;
	}
	return FMRES_IGNORED;
}

/// MSG_BROADCAST, MSG_PVS, MSG_PAS and MSG_ONE_UNRELIABLE go into the unreliable datagram of a client.
bool:ms_unreliable(dest)
{
	return (dest == MSG_BROADCAST || dest == MSG_PVS || dest == MSG_PAS || dest == MSG_ONE_UNRELIABLE);
}

/// How many clients a message with this destination reaches, at most.
ms_copies(dest)
{
	if (dest == MSG_ONE || dest == MSG_ONE_UNRELIABLE || dest == MSG_INIT)
	{
		return 1;
	}
	return g_humans > 0 ? g_humans : 1;
}

ms_commit()
{
	g_in_msg = false;

	new key = g_m_type;
	if (key < 0 || key >= MS_IDS)
	{
		key = 0;
	}
	if (g_m_type == MS_SVC_TEMPENTITY && g_m_te >= 0)
	{
		key = MS_IDS + g_m_te;
	}

	new est = g_m_bytes * ms_copies(g_m_dest);
	g_c_msgs[key]++;
	g_c_bytes[key] += g_m_bytes;
	if (ms_unreliable(g_m_dest))
	{
		g_c_estu[key] += est;
	}
	else
	{
		g_c_estr[key] += est;
	}
}

/// One server frame passed: the entities each client was sent since the last one are one update each.
public fw_startframe_post()
{
	g_frames_c++;
	if (g_fw_afp == -1)
	{
		return FMRES_IGNORED;
	}
	for (new h = 1; h <= g_maxplayers; h++)
	{
		new n = g_afp_n[h];
		if (!n)
		{
			continue;
		}
		new pl = g_afp_pl[h];
		new est = (n - pl) * MS_BYTES_ENTITY + pl * MS_BYTES_PLAYER + MS_BYTES_FRAME;
		g_a_sends[h]++;
		g_a_sum[h] += n;
		g_a_pl[h] += pl;
		g_a_bsp[h] += g_afp_bsp[h];
		if (n > g_a_max[h])
		{
			g_a_max[h] = n;
		}
		if (est > g_a_est_max[h])
		{
			g_a_est_max[h] = est;
		}
		if (est > MS_FRAME_LIMIT)
		{
			g_a_over[h]++;
		}
		g_afp_n[h] = 0;
		g_afp_pl[h] = 0;
		g_afp_bsp[h] = 0;
	}
	return FMRES_IGNORED;
}

public fw_afp_post(es, e, ent, host, hostflags, player, pSet)
{
	if (host < 1 || host > g_maxplayers || !get_orig_retval())
	{
		return FMRES_IGNORED;
	}
	g_afp_n[host]++;
	if (player)
	{
		g_afp_pl[host]++;
	}
	else if (get_es(es, ES_Solid) == MS_SOLID_BSP)
	{
		g_afp_bsp[host]++;
	}
	return FMRES_IGNORED;
}

/* ---- once a second ---------------------------------------------------------------------------- */

public task_ms_tick()
{
	ms_hooks(get_pcvar_num(g_cv_on) != 0);

	new players[MAX_PLAYERS];
	get_players(players, g_humans, "ch");
	new all;
	get_players(players, all, "");
	g_bots = all - g_humans;

	g_seconds_t++;
	g_frames_t += g_frames_c;
	if (g_win)
	{
		g_seconds_w++;
		g_frames_w += g_frames_c;
	}
	g_frames_c = 0;

	new sec_total;
	for (new k = 0; k < MS_KEYS; k++)
	{
		if (!g_c_msgs[k])
		{
			continue;
		}
		g_t_msgs[k] += g_c_msgs[k];
		g_t_bytes[k] += g_c_bytes[k];
		g_t_estu[k] += g_c_estu[k];
		g_t_estr[k] += g_c_estr[k];
		new now = g_c_estu[k] + g_c_estr[k];
		sec_total += now;
		if (g_win)
		{
			g_w_msgs[k] += g_c_msgs[k];
			g_w_bytes[k] += g_c_bytes[k];
			g_w_estu[k] += g_c_estu[k];
			g_w_estr[k] += g_c_estr[k];
			if (now > g_w_peak[k])
			{
				g_w_peak[k] = now;
			}
		}
		g_c_msgs[k] = 0;
		g_c_bytes[k] = 0;
		g_c_estu[k] = 0;
		g_c_estr[k] = 0;
	}

	if (g_win)
	{
		g_w_sec_sum += sec_total;
		if (sec_total > g_w_sec_peak)
		{
			g_w_sec_peak = sec_total;
		}
		if (get_gametime() >= g_w_end)
		{
			ms_finish();
		}
	}
}

/* ---- the command ------------------------------------------------------------------------------ */

public cmd_msgstats(id, level, cid)
{
	if (!cmd_access(id, level, cid, 1))
	{
		return PLUGIN_HANDLED;
	}

	new seconds = 60;
	if (read_argc() > 1)
	{
		new arg[16];
		read_argv(1, arg, charsmax(arg));
		seconds = str_to_num(arg);
	}

	if (seconds <= 0)
	{
		ms_report(id, false);
		return PLUGIN_HANDLED;
	}
	if (g_win)
	{
		ms_out(id, "[MSGSTATS] a window is already running, %d s left; its report goes to whoever started it.", floatround(g_w_end - get_gametime(), floatround_ceil));
		return PLUGIN_HANDLED;
	}
	if (!get_pcvar_num(g_cv_on))
	{
		ms_out(id, "[MSGSTATS] h9_msgstats_on is 0: set it to 1 first.");
		return PLUGIN_HANDLED;
	}

	seconds = clamp(seconds, 5, 600);
	ms_window_start(id, seconds);
	ms_out(id, "[MSGSTATS] counting for %d s; the report follows here and in the AMX Mod X log.", seconds);
	return PLUGIN_HANDLED;
}

ms_window_start(id, seconds)
{
	arrayset(g_w_msgs, 0, MS_KEYS);
	arrayset(g_w_bytes, 0, MS_KEYS);
	arrayset(g_w_estu, 0, MS_KEYS);
	arrayset(g_w_estr, 0, MS_KEYS);
	arrayset(g_w_peak, 0, MS_KEYS);
	arrayset(g_afp_n, 0, MS_SLOTS);
	arrayset(g_afp_pl, 0, MS_SLOTS);
	arrayset(g_afp_bsp, 0, MS_SLOTS);
	arrayset(g_a_sends, 0, MS_SLOTS);
	arrayset(g_a_sum, 0, MS_SLOTS);
	arrayset(g_a_max, 0, MS_SLOTS);
	arrayset(g_a_pl, 0, MS_SLOTS);
	arrayset(g_a_bsp, 0, MS_SLOTS);
	arrayset(g_a_est_max, 0, MS_SLOTS);
	arrayset(g_a_over, 0, MS_SLOTS);
	g_frames_w = 0;
	g_seconds_w = 0;
	g_w_sec_peak = 0;
	g_w_sec_sum = 0;
	g_w_seconds = seconds;
	g_w_end = get_gametime() + float(seconds);
	g_req = id;
	g_win = true;
	g_fw_afp = register_forward(FM_AddToFullPack, "fw_afp_post", 1);
}

ms_finish()
{
	g_win = false;
	if (g_fw_afp != -1)
	{
		unregister_forward(FM_AddToFullPack, g_fw_afp, 1);
		g_fw_afp = -1;
	}
	ms_report(g_req, true);
}

/* ---- the report ------------------------------------------------------------------------------- */

ms_out(id, const fmt[], any:...)
{
	static line[240];
	vformat(line, charsmax(line), fmt, 3);
	if (id > 0 && is_user_connected(id))
	{
		console_print(id, "%s", line);
	}
	else
	{
		server_print("%s", line);
	}
	log_amx("%s", line);
}

ms_resolve()
{
	for (new i = 0; i < MS_IDS; i++)
	{
		g_idname[i][0] = 0;
	}
	for (new i = 0; i < sizeof g_known; i++)
	{
		new msgid = get_user_msgid(g_known[i]);
		if (msgid > 0 && msgid < MS_IDS)
		{
			copy(g_idname[msgid], charsmax(g_idname[]), g_known[i]);
		}
	}
}

ms_name(key, name[], len)
{
	if (key >= MS_IDS)
	{
		new te = key - MS_IDS;
		for (new i = 0; i < sizeof g_te_code; i++)
		{
			if (g_te_code[i] == te)
			{
				formatex(name, len, "TE_%s", g_te_name[i]);
				return;
			}
		}
		formatex(name, len, "TE_%d", te);
		return;
	}
	if (g_idname[key][0])
	{
		copy(name, len, g_idname[key]);
		return;
	}
	for (new i = 0; i < sizeof g_svc_code; i++)
	{
		if (g_svc_code[i] == key)
		{
			copy(name, len, g_svc_name[i]);
			return;
		}
	}
	formatex(name, len, "msg#%d", key);
}

/// The report: the window's (window true) or the map's counters.
ms_report(id, bool:window)
{
	ms_resolve();

	new msgs[MS_KEYS], bytes[MS_KEYS], estu[MS_KEYS], estr[MS_KEYS], peak[MS_KEYS];
	new secs, frames;
	if (window)
	{
		secs = g_seconds_w;
		frames = g_frames_w;
		for (new k = 0; k < MS_KEYS; k++)
		{
			msgs[k] = g_w_msgs[k];
			bytes[k] = g_w_bytes[k];
			estu[k] = g_w_estu[k];
			estr[k] = g_w_estr[k];
			peak[k] = g_w_peak[k];
		}
	}
	else
	{
		secs = g_seconds_t;
		frames = g_frames_t;
		for (new k = 0; k < MS_KEYS; k++)
		{
			msgs[k] = g_t_msgs[k];
			bytes[k] = g_t_bytes[k];
			estu[k] = g_t_estu[k];
			estr[k] = g_t_estr[k];
		}
	}
	if (secs < 1)
	{
		secs = 1;
	}
	new Float:fsecs = float(secs);

	new map[40];
	get_mapname(map, charsmax(map));
	new used = engfunc(EngFunc_NumberOfEntities);
	ms_out(id, "[MSGSTATS] ---- %s on %s: %d s, server frames %.1f/s, humans %d, bots %d, edicts in use %d of %d ----",
		window ? "window" : "map totals", map, window ? g_w_seconds : secs, float(frames) / fsecs, g_humans, g_bots, used, global_get(glb_maxEntities));

	new total_u, total_r;
	for (new k = 0; k < MS_KEYS; k++)
	{
		total_u += estu[k];
		total_r += estr[k];
	}
	ms_out(id, "[MSGSTATS] messages, estimated bytes for all recipients: unreliable %d B/s, reliable %d B/s%s",
		floatround(float(total_u) / fsecs), floatround(float(total_r) / fsecs),
		window ? "" : " (a map's average)");
	if (window)
	{
		ms_out(id, "[MSGSTATS] busiest second: %d B for all recipients, average %d B/s", g_w_sec_peak, floatround(float(g_w_sec_sum) / fsecs));
	}
	ms_out(id, "[MSGSTATS]   %-22s %7s %6s %9s %5s %9s", "message", "msgs/s", "B/msg", "est B/s", "unrel", window ? "peak B/s" : "");

	new bool:taken[MS_KEYS];
	for (new n = 0; n < MS_TOP; n++)
	{
		new best = -1, bestv;
		for (new k = 0; k < MS_KEYS; k++)
		{
			new v = estu[k] + estr[k];
			if (!taken[k] && v > bestv)
			{
				best = k;
				bestv = v;
			}
		}
		if (best < 0)
		{
			break;
		}
		taken[best] = true;
		new name[32];
		ms_name(best, name, charsmax(name));
		ms_out(id, "[MSGSTATS]   %-22s %7.1f %6d %9d %4d%% %9d", name, float(msgs[best]) / fsecs, bytes[best] / msgs[best],
			floatround(float(bestv) / fsecs), estu[best] * 100 / bestv, window ? peak[best] : 0);
	}

	if (!window)
	{
		ms_out(id, "[MSGSTATS] h9_msgstats <seconds> counts the entities each client is sent as well.");
		return;
	}

	ms_out(id, "[MSGSTATS] entities per update (AddToFullPack), priced as new to the client: %d B an entity, %d B a player, %d B around them; a frame holds %d B:",
		MS_BYTES_ENTITY, MS_BYTES_PLAYER, MS_BYTES_FRAME, MS_FRAME_LIMIT);
	ms_out(id, "[MSGSTATS]   %-4s %-16s %8s %6s %6s %6s %7s %8s %6s", "slot", "name", "updates/s", "avg", "max", "bsp", "players", "est max B", "over");
	new any;
	for (new h = 1; h <= g_maxplayers; h++)
	{
		if (!g_a_sends[h])
		{
			continue;
		}
		any++;
		new name[32];
		get_user_name(h, name, charsmax(name));
		new sends = g_a_sends[h];
		ms_out(id, "[MSGSTATS]   %-4d %-16.16s %8.1f %6d %6d %6d %7d %8d %6d", h, name, float(sends) / fsecs, g_a_sum[h] / sends,
			g_a_max[h], g_a_bsp[h] / sends, g_a_pl[h] / sends, g_a_est_max[h], g_a_over[h]);
	}
	if (!any)
	{
		ms_out(id, "[MSGSTATS]   no client was sent an update in the window.");
	}
	else if (g_humans > 0)
	{
		new sends_all;
		for (new h = 1; h <= g_maxplayers; h++)
		{
			sends_all += g_a_sends[h];
		}
		new per_update = floatround(float(total_u) / float(sends_all > 0 ? sends_all : 1));
		ms_out(id, "[MSGSTATS] unreliable messages: about %d B an update for each client, which the datagram shares with the entities above.", per_update);
	}

	ms_classes(id);
}

/// The edicts that carry a model, which is what AddToFullPack can send, by class.
ms_classes(id)
{
	new names[MS_CLASSES][32], counts[MS_CLASSES];
	new used, other, modeled;
	new max = global_get(glb_maxEntities);
	for (new e = 1; e < max; e++)
	{
		if (!pev_valid(e) || !pev(e, pev_modelindex))
		{
			continue;
		}
		modeled++;
		new cls[32];
		pev(e, pev_classname, cls, charsmax(cls));
		new slot = -1;
		for (new i = 0; i < used; i++)
		{
			if (equal(names[i], cls))
			{
				slot = i;
				break;
			}
		}
		if (slot < 0)
		{
			if (used >= MS_CLASSES)
			{
				other++;
				continue;
			}
			slot = used++;
			copy(names[slot], charsmax(names[]), cls);
		}
		counts[slot]++;
	}

	ms_out(id, "[MSGSTATS] edicts with a model: %d (the most any client can be sent); by class:", modeled);
	new bool:taken[MS_CLASSES];
	for (new n = 0; n < 14; n++)
	{
		new best = -1, bestv;
		for (new i = 0; i < used; i++)
		{
			if (!taken[i] && counts[i] > bestv)
			{
				best = i;
				bestv = counts[i];
			}
		}
		if (best < 0)
		{
			break;
		}
		taken[best] = true;
		ms_out(id, "[MSGSTATS]   %-26s %5d", names[best], bestv);
	}
	if (other)
	{
		ms_out(id, "[MSGSTATS]   (%d more in classes past the first %d)", other, MS_CLASSES);
	}
}
