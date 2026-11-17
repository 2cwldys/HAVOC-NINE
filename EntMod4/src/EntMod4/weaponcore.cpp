#include "plugin.h"
#ifdef _WIN32
#include <string.h>
#else
#include <strings.h>
#endif

// EntMod4 -- reconstructed: the custom-weapon framework (original weaponcore.cpp). EntMod wraps one
// custom weapon, the entity mover (weapon-id marker 0x5a in NewWeapons[idx][0]); the Primary*/Weapon*
// entry points route its attack/deploy/holster through the entmover.cpp tool. NewWeapons is EntMod's
// per-player weapon state, ENT_MAXPLAYERS slots of 0x48 bytes: [+0] active weapon id, [+4] active flag,
// [+0x10] attack-held flag, [+0x14] saved viewmodel, [+0x18] saved weaponmodel, [+0x1c] underlying id.

char NewWeapons[ENT_MAXPLAYERS * 0x48];

static inline int &NW(edict_t *player, int off)
{
	return *(int *)(NewWeapons + ENTINDEX(player) * 0x48 + off);
}

// H9: is the entity-mover weapon out for this player (NewWeapons id >= 0x5a)? Used to keep the weapon's
// per-frame handling (the attack block in DFPlayerPreThink) running wherever the tool is equipped, even
// on a map where the entmod gate is off, so it never leaves the underlying weapon firing (the kung-fu).
int EntmoverActive(edict_t *player)
{
	return NW(player, 0) >= 0x5a;
}

// PrimaryAttack @0x58360
void PrimaryAttack(edict_t *player)
{
	if (NW(player, 0x10) == 0 && NW(player, 0) == 0x5a)
		EntMoverAttack(player);
}

// PrimaryAttackOff @0x583b0
void PrimaryAttackOff(edict_t *player)
{
	NW(player, 0x10) = 0;
	if (NW(player, 0) == 0x5a)
		EntMoverOff(player);
}

// PrimaryContinue @0x58400
void PrimaryContinue(edict_t *player)
{
	if (NW(player, 0x10) == 0 && NW(player, 0) == 0x5a)
		EntMoverContinue(player);
}

// PrimaryIdle @0x58450
void PrimaryIdle(edict_t *player)
{
}

// PrimaryAlways @0x58460
void PrimaryAlways(edict_t *player)
{
}

// WeaponPrecache @0x58470
void WeaponPrecache(void)
{
	PRECACHE_MODEL("addons/EntMod/models/v_phaser.mdl");
	PRECACHE_MODEL("addons/EntMod/models/p_phaser.mdl");
	PRECACHE_SOUND("items/inv3.wav");
}

// WeaponDeploy @0x58480
void WeaponDeploy(edict_t *player)
{
	NW(player, 0x10) = 0;
	if (NW(player, 0) == 0x5a)
		EntMoverDeploy(player);
}

// WeaponHolster @0x584d0
void WeaponHolster(edict_t *player)
{
}

// WeaponSpecial @0x584e0
void WeaponSpecial(edict_t *player)
{
	if (NW(player, 0) == 0x5a)
		EntMoverSpecial(player);
}

// WeaponForceOff @0x58520
void WeaponForceOff(edict_t *player)
{
	PrimaryAttackOff(player);
	NW(player, 4) = 0;
}

// WeaponCheck @0x58550
void WeaponCheck(edict_t *player)
{
}

// WeaponDisconnect @0x58560
void WeaponDisconnect(edict_t *player)
{
	if (NW(player, 0) != 0x5a)
		return;
	if (NW(player, 4) != 0)
		WeaponForceOff(player);
	NW(player, 0) = NW(player, 0x1c);
}

// DFWeaponForId @0x58600 -- weapon id -> classname, per host mod (tfc / cstrike / ns).
const char *DFWeaponForId(int weaponId)
{
	if (strcasecmp(moddir, "tfc") == 0)
	{
		switch (weaponId)
		{
		case 3:    return "tf_weapon_medikit";
		case 4:    return "tf_weapon_spanner";
		case 5:    return "tf_weapon_axe";
		case 6:    return "tf_weapon_sniperrifle";
		case 7:    return "tf_weapon_autorifle";
		case 8:    return "tf_weapon_shotgun";
		case 9:    return "tf_weapon_supershotgun";
		case 10:   return "tf_weapon_ng";
		case 0xb:  return "tf_weapon_superng";
		case 0xc:  return "tf_weapon_gl";
		case 0xd:  return "tf_weapon_flamethrower";
		case 0xe:  return "tf_weapon_rpg";
		case 0xf:  return "tf_weapon_ic";
		case 0x11: return "tf_weapon_ac";
		case 0x14: return "tf_weapon_tranq";
		case 0x15: return "tf_weapon_railgun";
		case 0x16: return "tf_weapon_pl";
		case 0x17: return "tf_weapon_knife";
		}
	}
	else if (strcasecmp(moddir, "cstrike") == 0)
	{
		switch (weaponId)
		{
		case 1:    return "weapon_p228";
		case 3:    return "weapon_scout";
		case 4:    return "weapon_hegrenade";
		case 5:    return "weapon_xm1014";
		case 6:    return "weapon_c4";
		case 7:    return "weapon_mac10";
		case 8:    return "weapon_aug";
		case 9:    return "weapon_smokegrenade";
		case 10:   return "weapon_elite";
		case 0xb:  return "weapon_fiveseven";
		case 0xc:  return "weapon_ump45";
		case 0xd:  return "weapon_sg550";
		case 0x10: return "weapon_usp";
		case 0x11: return "weapon_glock18";
		case 0x12: return "weapon_awp";
		case 0x13: return "weapon_mp5navy";
		case 0x14: return "weapon_m249";
		case 0x15: return "weapon_m3";
		case 0x16: return "weapon_m4a1";
		case 0x17: return "weapon_tmp";
		case 0x18: return "weapon_g3sg1";
		case 0x19: return "weapon_flashbang";
		case 0x1a: return "weapon_deagle";
		case 0x1b: return "weapon_sg552";
		case 0x1c: return "weapon_ak47";
		case 0x1d: return "weapon_knife";
		case 0x1e: return "weapon_p90";
		}
	}
	else if (strcasecmp(moddir, "ns") == 0)
	{
		switch (weaponId)
		{
		case 1:    return "weapon_claws";
		case 2:    return "weapon_spit";
		case 3:    return "weapon_spore";
		case 4:    return "weapon_spikegun";
		case 5:    return "weapon_bitegun";
		case 6:    return "weapon_bite2gun";
		case 7:    return "weapon_swipe";
		case 8:    return "weapon_webspinner";
		case 9:    return "weapon_paralysis";
		case 10:   return "weapon_parasite";
		case 0xb:  return "weapon_blink";
		case 0xc:  return "weapon_divinewind";
		case 0xd:  return "weapon_knife";
		case 0xe:  return "weapon_pistol";
		case 0xf:  return "weapon_machinegun";
		case 0x10: return "weapon_shotgun";
		case 0x11: return "weapon_heavymachinegun";
		case 0x12: return "weapon_welder";
		case 0x13: return "weapon_mine";
		case 0x14: return "weapon_grenadegun";
		case 0x15: return "weapon_leap";
		case 0x16: return "weapon_charge";
		case 0x17: return "weapon_umbra";
		case 0x18: return "weapon_primalscream";
		case 0x19: return "weapon_bilebombgun";
		case 0x1a: return "weapon_acidrocketgun";
		case 0x1b: return "weapon_healingspray";
		case 0x1c: return "weapon_babblergun";
		}
	}
	return "lastinv";
}

// DFDefaultDeploy @0x58960
void DFDefaultDeploy(edict_t *player, const char *viewModel, const char *weaponModel,
                     int anim, const char *animExt, int skiplocal, int body)
{
	player->v.viewmodel   = MAKE_STRING(viewModel);
	player->v.weaponmodel = MAKE_STRING(weaponModel);
	player->v.weaponanim  = anim;

	if (skiplocal != 0)
		return;

	MESSAGE_BEGIN(MSG_ONE, SVC_WEAPONANIM, NULL, player);
	WRITE_BYTE(anim);
	WRITE_BYTE(body);
	MESSAGE_END();
}

// DFSendWeaponAnim @0x58a10
void DFSendWeaponAnim(edict_t *player, int anim)
{
	player->v.weaponanim = anim;

	MESSAGE_BEGIN(MSG_ONE, SVC_WEAPONANIM, NULL, player);
	WRITE_BYTE(anim);
	WRITE_BYTE(player->v.body);
	MESSAGE_END();
}
