/*
 * h9_staticprops -- the map's props and sprites that never change, drawn by the client alone.
 *
 * A ts_model (a crate, a pallet, a bin) or an env_sprite that nothing addresses is an entity the
 * server sends every client that can see it, update after update, though nothing about it ever
 * changes. On a big open map that is hundreds of entities in every player's view and most of the
 * ten bytes each costs when a client is sent its view whole. The engine can hand such an entity to
 * the clients instead: EngFunc_MakeStatic puts it into the map's sign-on data, once, and frees the
 * server's edict. The client draws it from then on and the server does not mention it again.
 *
 * A prop is made static only when nothing can reach it: no targetname, no target, no parent, no
 * owner, not hidden, and, for a sprite, not animated and not a one-shot. A static entity is not
 * solid for the game any more, which a ts_model, whose box is a point, never was either.
 *
 * It runs at plugin_cfg, while the map is still loading: static entities are only taken then. That
 * is before the map's own config (ts\mapconfigs\<map>.cfg) is read, so the setting is the
 * plugin's own cfg (configs\h9_staticprops.cfg) and not a mapconfig's.
 *
 *   h9_staticprops 0   off (the default)
 *   h9_staticprops 1   on roleplay maps (rp_, tsrp_ in the name)
 *   h9_staticprops 2   on every map
 */
#include <amxmodx>
#include <amxmisc>
#include <fakemeta>

#define PLUGIN  "H9 Static Props"
#define VERSION "1.0"
#define AUTHOR  "H9"

// the engine holds 3096 static entities in all
#define SP_LIMIT        3000

#define SP_SF_ONCE      2
#define SP_EF_NODRAW    128

new g_cv_on;

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR);
	g_cv_on = register_cvar("h9_staticprops", "0");
}

public plugin_cfg()
{
	// AMXX only runs amxx.cfg by itself: a plugin's own cfg is run by the plugin
	new cfgdir[64], cfgfile[160];
	get_configsdir(cfgdir, charsmax(cfgdir));
	formatex(cfgfile, charsmax(cfgfile), "%s/h9_staticprops.cfg", cfgdir);
	if (file_exists(cfgfile))
	{
		server_cmd("exec %s", cfgfile);
		server_exec();
	}

	new mode = get_pcvar_num(g_cv_on);
	if (mode <= 0)
	{
		return;
	}

	new map[48];
	get_mapname(map, charsmax(map));
	if (mode == 1 && !roleplay_map(map))
	{
		return;
	}

	new made, kept;
	made += make_static("ts_model", false, kept);
	made += make_static("env_sprite", true, kept);
	log_amx("[STATICPROPS] %s: %d props and sprites handed to the clients, %d left to the server.", map, made, kept);
}

bool:roleplay_map(const name[])
{
	return equali(name, "rp_", 3) || equali(name, "tsrp_", 5) || containi(name, "_rp_") != -1 || containi(name, "_tsrp_") != -1;
}

/// Hands every entity of a class that nothing can reach to the clients; the number made static.
make_static(const classname[], bool:sprite, &kept)
{
	new made;
	new ent = 0;
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", classname)) > 0)
	{
		if (made >= SP_LIMIT)
		{
			kept++;
			continue;
		}
		if (!may_be_static(ent, sprite))
		{
			kept++;
			continue;
		}
		engfunc(EngFunc_MakeStatic, ent);
		made++;
	}
	return made;
}

bool:may_be_static(ent, bool:sprite)
{
	if (!pev(ent, pev_modelindex) || (pev(ent, pev_effects) & SP_EF_NODRAW))
	{
		return false;
	}
	if (pev(ent, pev_aiment) || pev(ent, pev_owner) || pev(ent, pev_movetype) == MOVETYPE_FOLLOW)
	{
		return false;
	}

	new text[32];
	pev(ent, pev_targetname, text, charsmax(text));
	if (text[0])
	{
		return false;
	}
	pev(ent, pev_target, text, charsmax(text));
	if (text[0])
	{
		return false;
	}

	if (sprite)
	{
		if ((pev(ent, pev_spawnflags) & SP_SF_ONCE) || engfunc(EngFunc_ModelFrames, pev(ent, pev_modelindex)) > 1)
		{
			return false;
		}
	}
	return true;
}
