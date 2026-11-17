#include "hookmod.h"

// HookMod -- the 24 DF_hook_* server cvars. Defaults are PE-authoritative (the contiguous cvar_t
// array at VA 0x1002f770 in the shipped DLL). DF_hook_on is the master enable and carries
// ARCHIVE|SERVER; every other cvar is ARCHIVE so it persists in the server config.

cvar_t DF_hook_on                = { "DF_hook_on",                "1",    FCVAR_ARCHIVE | FCVAR_SERVER };
cvar_t DF_hook_deployspeed       = { "DF_hook_deployspeed",       "1500", FCVAR_ARCHIVE };
cvar_t DF_hook_speed             = { "DF_hook_speed",             "1.5",  FCVAR_ARCHIVE };
cvar_t DF_hook_ground            = { "DF_hook_ground",            "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_showspy           = { "DF_hook_showspy",           "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_sound             = { "DF_hook_sound",             "1",    FCVAR_ARCHIVE };
cvar_t DF_hook_hold              = { "DF_hook_hold",              "15",   FCVAR_ARCHIVE };
cvar_t DF_hook_sky               = { "DF_hook_sky",               "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_players           = { "DF_hook_players",           "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_onlywalls         = { "DF_hook_onlywalls",         "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_color             = { "DF_hook_color",             "1",    FCVAR_ARCHIVE };
cvar_t DF_hook_gravity           = { "DF_hook_gravity",           "0.5",  FCVAR_ARCHIVE };
cvar_t DF_hook_instant           = { "DF_hook_instant",           "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_swing             = { "DF_hook_swing",             "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_swing_acceleration= { "DF_hook_swing_acceleration","150",  FCVAR_ARCHIVE };
cvar_t DF_hook_swing_reelspeed   = { "DF_hook_swing_reelspeed",   "200",  FCVAR_ARCHIVE };
cvar_t DF_hook_swing_minlength   = { "DF_hook_swing_minlength",   "100",  FCVAR_ARCHIVE };
cvar_t DF_hook_wait              = { "DF_hook_wait",              "0.05", FCVAR_ARCHIVE };
cvar_t DF_hook_forcespeed        = { "DF_hook_forcespeed",        "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_width             = { "DF_hook_width",             "20",   FCVAR_ARCHIVE };
cvar_t DF_hook_noise             = { "DF_hook_noise",             "1",    FCVAR_ARCHIVE };
cvar_t DF_hook_weapon            = { "DF_hook_weapon",            "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_usekey            = { "DF_hook_usekey",            "0",    FCVAR_ARCHIVE };
cvar_t DF_hook_password          = { "DF_hook_password",          "0",    FCVAR_ARCHIVE };

void RegisterHookCvars(void)   // FUN_1000ec30
{
	CVAR_REGISTER(&DF_hook_on);
	CVAR_REGISTER(&DF_hook_deployspeed);
	CVAR_REGISTER(&DF_hook_speed);
	CVAR_REGISTER(&DF_hook_ground);
	CVAR_REGISTER(&DF_hook_showspy);
	CVAR_REGISTER(&DF_hook_sound);
	CVAR_REGISTER(&DF_hook_hold);
	CVAR_REGISTER(&DF_hook_sky);
	CVAR_REGISTER(&DF_hook_players);
	CVAR_REGISTER(&DF_hook_onlywalls);
	CVAR_REGISTER(&DF_hook_color);
	CVAR_REGISTER(&DF_hook_gravity);
	CVAR_REGISTER(&DF_hook_instant);
	CVAR_REGISTER(&DF_hook_swing);
	CVAR_REGISTER(&DF_hook_swing_acceleration);
	CVAR_REGISTER(&DF_hook_swing_reelspeed);
	CVAR_REGISTER(&DF_hook_swing_minlength);
	CVAR_REGISTER(&DF_hook_wait);
	CVAR_REGISTER(&DF_hook_forcespeed);
	CVAR_REGISTER(&DF_hook_width);
	CVAR_REGISTER(&DF_hook_noise);
	CVAR_REGISTER(&DF_hook_weapon);
	CVAR_REGISTER(&DF_hook_usekey);
	CVAR_REGISTER(&DF_hook_password);
}
