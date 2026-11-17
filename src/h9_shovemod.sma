#include <amxmodx>
#include <amxmisc>
#include <fakemeta>
#include <ApolloRP_H9Ctx>

#define PLUGIN "Shove Mod"
#define VERSION "1.1"
#define AUTHOR "Styles / H9"

new cShove, cCooldown, cInUse
new gLastShove[MAX_PLAYERS + 1]
new g_ShoveSound[] = "h9/shove/shove.wav"

public plugin_natives()
{
	// Load even on a server without ARP_H9Ctx; ARP_H9CtxAdd then does nothing.
	set_native_filter("ARP_H9CtxFilter")
}

public plugin_precache()
{
	precache_sound(g_ShoveSound)
}

public plugin_init()
{
	register_plugin(PLUGIN, VERSION, AUTHOR)
	register_clcmd("say /shove", "shovePlayer")
	cShove = register_cvar("shove_force", "7")
	cCooldown = register_cvar("shove_cooldown", "10")
	cInUse = register_cvar("shove_allow_inuse", "1")

	register_forward(FM_PlayerPreThink, "Forward_PlayerPreThink")
}

public Forward_PlayerPreThink(id)
{
	if(!get_pcvar_num(cInUse))
		return PLUGIN_HANDLED
	// On an ARP map the use key opens the ARP context menu (Shove is an entry there), so don't
	// also fire the raw use-key shove -- that would double up with ARP's own use handling.
	if(get_cvar_num("arp_h9_ctxmenu"))
		return PLUGIN_CONTINUE
	if(pev( id, pev_button ) & IN_USE && !(pev( id, pev_oldbuttons ) & IN_USE ) & !is_user_bot(id))
		shovePlayer(id)

	return PLUGIN_CONTINUE
}

public shovePlayer(id)
{
	if(!is_user_alive(id))
		return PLUGIN_HANDLED

	new Index, Body
	get_user_aiming(id, Index, Body, 200)
	if(!Index || !is_user_alive(Index))
		return PLUGIN_HANDLED

	do_shove(id, Index)
	return PLUGIN_HANDLED
}

// Apply the shove of `id` on `target`: enforce the per-player cooldown and the crouch guard, fling
// the target away, play the shove sound, and tell both players. Shared by the /shove command, the
// use key, and the ARP context-menu entry.
do_shove(id, target)
{
	if(get_systime() - gLastShove[id] < get_pcvar_num(cCooldown))
	{
		client_print(id, print_chat, "[Shove Mod] Your muscles are weak from shoving the player. You must wait to do it again. (%i)", (get_pcvar_num(cCooldown) - (get_systime() - gLastShove[id])))
		return
	}

	new Float:size[3]
	pev(id, pev_size, size)
	if(size[2] < 72.0)
	{
		client_print(id, print_chat, "[Shove Mod] You can't shove somebody while doing that action.")
		return
	}

	new pName[64], tName[64]
	get_user_name(id, pName, 63)
	get_user_name(target, tName, 63)

	new Float:velocity[3], Float:shover[3], Float:shovee[3]
	pev(id, pev_origin, shover)
	pev(target, pev_origin, shovee)
	for(new Count; Count < 3; Count++)
		velocity[Count] = (shovee[Count] - shover[Count]) * get_pcvar_float(cShove)
	set_pev(target, pev_velocity, velocity)

	emit_sound(target, CHAN_BODY, g_ShoveSound, VOL_NORM, ATTN_NORM, 0, PITCH_NORM)
	client_print(id, print_chat, "[Shove Mod] You have just shoved %s!", tName)
	client_print(target, print_chat, "[Shove Mod] You have just been shoved by %s!", pName)
	gLastShove[id] = get_systime()
}

// ---- ARP context menu (the use key on a player) : offer "Shove" ----
public ARP_H9CtxBuild(id, target)
{
	new note[34] = ""
	new bool:ok = true

	new Float:size[3]
	pev(id, pev_size, size)
	new remain = get_pcvar_num(cCooldown) - (get_systime() - gLastShove[id])

	if(size[2] < 72.0)
	{
		ok = false
		copy(note, 33, "not while crouched")
	}
	else if(remain > 0)
	{
		ok = false
		formatex(note, 33, "wait %ds", remain)
	}
	ARP_H9CtxAdd("Shove", "ctx_shove", ok, note)
}

public ctx_shove(id, target)
{
	do_shove(id, target)
}
