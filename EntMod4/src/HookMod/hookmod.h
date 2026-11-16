#pragma once
#include <extdll.h>
#include <meta_api.h>
#ifdef _WIN32
#include <string.h>
#ifndef strcasecmp
#define strcasecmp  _stricmp
#define strncasecmp _strnicmp
#endif
#endif

// ======================================================================================
// HookMod ("Hook Mod v5") -- reconstructed source: shared declaration contract.
// Metamod-only grappling-hook plugin (the shipped HookMod_MM.dll also ran as a standalone game
// DLL via a LoadLibrary chainload of mp.dll + 612 entity trampolines; that personality is dropped,
// exactly as EntMod's reconstruction did -- this build REQUIRES Metamod-R).
//
// Addresses below are from the PE decompile (image base 0x10000000). The cached enginefuncs_t base
// is DAT_10054090 and gpGlobals is DAT_10054314; a (*DAT_1005XXXX)(...) call decodes to the SDK
// macro whose enginefuncs_t offset is (addr - 0x10054090). Entity fields are written by SDK field
// name (pev->origin, ...), not raw offsets.
// ======================================================================================

// ---- the 24 DF_hook_* server cvars (defined + registered in cvars.cpp; PE-authoritative defaults) ----
extern cvar_t DF_hook_on;                  // master enable (default 1, ARCHIVE|SERVER)
extern cvar_t DF_hook_deployspeed;         // 1500  projectile tip launch speed
extern cvar_t DF_hook_speed;               // 1.5   reel pull speed (x maxspeed)
extern cvar_t DF_hook_ground;              // 0     allow pulling into ground (z<0)
extern cvar_t DF_hook_showspy;             // 0     draw rope in team color
extern cvar_t DF_hook_sound;               // 1     play fire sound
extern cvar_t DF_hook_hold;                // 15    max attached time (s)
extern cvar_t DF_hook_sky;                 // 0     allow attaching to sky
extern cvar_t DF_hook_players;             // 0     allow attaching to players
extern cvar_t DF_hook_onlywalls;           // 0     restrict attach to world/walls
extern cvar_t DF_hook_color;               // 1     rope color enum 1..5
extern cvar_t DF_hook_gravity;             // 0.5   tip projectile gravity
extern cvar_t DF_hook_instant;             // 0     instant hit-scan vs projectile
extern cvar_t DF_hook_swing;               // 0     pendulum swing vs straight reel
extern cvar_t DF_hook_swing_acceleration;  // 150   swing input accel
extern cvar_t DF_hook_swing_reelspeed;     // 200   rope reel in/out rate
extern cvar_t DF_hook_swing_minlength;     // 100   min rope length clamp
extern cvar_t DF_hook_wait;                // 0.05  re-fire cooldown (s)
extern cvar_t DF_hook_forcespeed;          // 0     constant-force pull (overrides the speed curve)
extern cvar_t DF_hook_width;               // 20    beam width
extern cvar_t DF_hook_noise;               // 1     beam noise/amplitude
extern cvar_t DF_hook_weapon;              // 0     beam weapon/render flag
extern cvar_t DF_hook_usekey;              // 0     fire the hook with +use
extern cvar_t DF_hook_password;            // "0"   required login password ("0" = none)

void RegisterHookCvars(void);              // cvars.cpp: CVAR_REGISTER all 24 (from HookGameDLLInit)

// ---- H9 gate (h9_gate.cpp): HookMod is inert unless this is an entmap or `entmod 1` ----
void H9HookGameInit(void);                 // register entmod/entmod_maps (from HookGameDLLInit)
void H9HookServerActivate(void);           // compute active at level start
int  H9HookActive(void);                   // gate the fire path (1 = active)

// ---- per-player hook state (original: base 0x10055658, stride 0x60; one slot per ENTINDEX) ----
#define HOOK_MAXPLAYERS 33
struct hookstate_t
{
	int      hookstate;         // +0x00  0 idle / 1 deploying (tip in flight) / 2 attached
	float    lastHookTime;      // +0x04  cooldown stamp (gpGlobals->time at retract)
	float    holdExpiry;        // +0x08  attach expiry time (DF_hook_hold)
	int      _pad0c;            // +0x0c
	vec3_t   anchorOffset;      // +0x10  local offset into the hooked entity
	edict_t *anchoredEnt;       // +0x1c  entity the hook is attached to
	edict_t *tipEnt;            // +0x20  grapple-tip projectile entity
	edict_t *beamEnt;           // +0x24  rope CBeam entity
	vec3_t   anchorPoint;       // +0x28  world attach point
	float    ropeRestLen;       // +0x34  swing rope rest length
	int      savedGravityFlag;  // +0x38  non-zero if savedGravity holds the player's pre-hook gravity
	float    savedGravity;      // +0x3c  restored on retract
	float    swingReelCooldown; // +0x40
	char     password[24];      // +0x44  per-player login (hook_login) checked against DF_hook_password
	char     _pad5c;            // +0x5c
	char     usekeyEdge;        // +0x5d  +use rising-edge latch (DF_hook_usekey)
	char     _pad5e[2];         // +0x5e  -> struct size 0x60
};
extern hookstate_t g_hook[HOOK_MAXPLAYERS];

// ---- DLL_FUNCTIONS hook handlers (wired in dllapi.cpp) ----
void     HookGameDLLInit(void);                                                        // pfnGameInit: RegisterHookCvars
int      HookSpawn(edict_t *pent);                                                     // pfnSpawn: precache on worldspawn (@0x10011250)
qboolean HookClientConnect(edict_t *pent, const char *name, const char *addr, char reject[128]); // @0x100112d0 reset slot
void     HookClientPutInServer(edict_t *pent);
void     HookClientCommand(edict_t *pent);                                             // pfnClientCommand -> +hook/-hook/hook_login
void     HookPlayerPreThink(edict_t *player);                                          // @0x10010620 usekey autofire + physics
void     HookStartFrame(void);                                                         // @0x100117f0 cvar cache + drive tip think
void     HookAlertSniffer(ALERT_TYPE atype, const char *szFmt, ...);                   // engine pfnAlertMessage post-hook @0x100030e0 (round events)

// ---- the mechanic (hook.cpp) ----
int      FireHookCmd(edict_t *player, int mode);   // @0x1000ed40: parse +hook/-hook/hook_login; fire/deploy. mode: 0 command, 1/2 usekey autofire
void     HookPhysics(edict_t *player);             // @0x1000f990: per-frame reel (DF_hook_swing 0) or constrained swing (DF_hook_swing 1)
void     GrappleTipThink(edict_t *tip);            // @0x10010900: projectile travel + collision -> attach, build/update the beam
void     KillHook(edict_t *player);                // @0x100104c0: retract (kill tip+beam, restore gravity, stamp cooldown)
void     RoundReset(void);                         // @0x100116f0: retract every active hook, print "Round Start!"
Vector   HookRopeColor(edict_t *player);           // @0x10013560 + color enum: the rope RGB (team color if DF_hook_showspy, else DF_hook_color 1..5)

// ---- beam (beam.cpp, ported HLSDK CBeam over entvars_t*) ----
void     SetStartEntity(int entindex, entvars_t *pev);
void     SetEndEntity(int entindex, entvars_t *pev);
float   *GetStartPos(entvars_t *pev);
float   *GetEndPos(entvars_t *pev);
void     BeamInit(const char *sprite, int width, entvars_t *pev);
edict_t *BeamCreate(const char *sprite, int width);
void     RelinkBeam(entvars_t *pev);
void     EntsInit(int startIndex, int endIndex, entvars_t *pev);
void     PointEntInit(const Vector &start, int endIndex, entvars_t *pev);
void     HoseInit(const Vector &start, const Vector &end, entvars_t *pev);
void     PointsInit(const Vector &start, const Vector &end, entvars_t *pev);
