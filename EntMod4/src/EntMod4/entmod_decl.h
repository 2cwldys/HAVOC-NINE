#pragma once

// ======================================================================================
// EntMod4 -- SHARED DECLARATION CONTRACT for the parallel body reconstruction.
//
// Included at the end of plugin.h (so extdll.h / meta_api.h are already in scope). It declares
// every EntMod-own global and every not-yet-implemented cross-module function, typed to real SDK
// types, with the decompile address of each. Signatures come from the non-stripped decompile
// (EntMod_i386.so.c); offsets are decoded to field names via DECODE.txt / ev_offsets.txt, so the
// bodies use pev->field, never raw offsets.
//
// (stock)  = verbatim/near-verbatim HLSDK or TS util.cpp/mathlib helper -- body is a COPY.
// (custom) = EntMod-specific logic -- body reconstructed from the decompile.
//
// NOT declared here (declared elsewhere, do not duplicate):
//   plugin.h  : moddir, EntInfo3/playerstate_t, NextAdminCheck, firstserverframe,
//               CheckAdmin, IsAdmin, UTIL_IsValidEntity, DFEntMover, DFEntAdmin.
//   SDK       : gpGlobals, g_engfuncs, gpMetaGlobals, gpGamedllFuncs, gpMetaUtilFuncs.
//   util.h    : meta_api.h -> mutil.h pulls in hlsdk/dlls/util.h, which already provides
//               FStrEq, UTIL_SetSize, UTIL_SetOrigin, UTIL_TraceLine (5-arg) as inlines and
//               UTIL_VarArgs / UTIL_LogPrintf as externs -- so those are NOT declared here.
//   dllapi.cpp: the six admin-path DLL_FUNCTIONS handlers (DFGameDLLInit, DFClientConnect,
//               DFClientDisconnect, DFClientPutInServer, DFClientCommand, DFStartFrame) are
//               locally prototyped there and defined in dll.cpp; they are EXPANDED in place
//               (see RECON_MANIFEST.txt), not re-declared here.
// ======================================================================================

// Incomplete types used only through pointers/references below (no SDK header pulled for them).
class  CBaseEntity;        // dlls/cbase.h -- only CBaseEntity* is needed here
struct hudtextparms_s;     // dlls/util.h
struct ScreenFade;         // UTIL_ScreenFade* parameter struct
struct mapcycle_s;         // map-cycle parser state

// ======================================================================================
// EntMod-own global variables the decompile uses.
// ======================================================================================

extern char  mr_meta;      // set when loaded under Metamod; the m_* bridges branch on it
extern char  ModCmd;       // non-zero while an injected client command is being read (Cmd_Arg*)
extern void *h_Library;    // dlopen handle of the real game DLL (entity trampolines; shim-only)

// Registered user-message ids (DFRegisterUserMessages, @0x337f0). REG_USER_MSG returns int.
extern int ntfDidRegister;      // one-shot guard: messages registered?
extern int ntfMsgIdMOTD;
extern int ntfMsgIdServerName;
extern int ntfMsgIdSecAmmoVal;
extern int ntfMsgIdAmmoX;
extern int ntfMsgIdWeaponList;
extern int ntfMsgIdCurWeapon;
extern int ntfMsgIdAmmoPickup;
extern int ntfMsgIdWeapPickup;
extern int ntfMsgIdScoreInfo;
extern int ntfMsgIdBuildSt;
extern int ntfMsgIdResetHUD;
extern int gmsgShowMenu;

extern cvar_t DF_entversion;    // plugin version cvar, registered in DFGameDLLInit (@0x52130)

// Entity-tool tables. Exact per-slot layout grows as the modules land (parallel to EntInfo3);
// declared opaque here so pointer arithmetic (table + index*stride) compiles unambiguously.
extern char Entities[];         // es_ entity-save table: 1024 slots x 0x640 bytes, classname @ +0
extern int  EntInfo[256];       // zeroed on worldspawn (DFDispatchSpawn); purpose TBD
extern char NewWeapons[];       // custom-weapon state, ENT_MAXPLAYERS slots x 0x48 bytes
                                //   +0 weapon id/state, +4 active flag, +0x14 saved viewmodel,
                                //   +0x18 saved weaponmodel, +0x1c underlying weapon id
extern int  precached_models;   // model index of sprites/laserbeam.spr (beam/mover effects)

// ======================================================================================
// ---- dispatch (dispatch.cpp): metamod bridges + the DF* hook handlers ----
// The m_* bridges run EntMod's handler, then fall through to the real gamedll via gpGamedllFuncs.
// ======================================================================================

void  DFRegisterUserMessages(void);                               // @0x337f0 (custom)
int   m_DispatchSpawn(edict_t *pent);                             // @0x33950 (custom)
void  m_DispatchUse(edict_t *pActivator, edict_t *pCaller);       // @0x339a0 (custom)
void  m_DispatchTouch(edict_t *pToucher, edict_t *pTouched);      // @0x33a10 (custom)
void  m_DispatchKeyValue(edict_t *pent, KeyValueData *pkvd);      // @0x33a80 (custom)
void  m_ClientCommand(edict_t *pent);                             // @0x33af0 (custom)
const char *Cmd_Argv(int argc);                                   // @0x33b50 (custom)
int   Cmd_Argc(void);                                             // @0x33bd0 (custom)
const char *Cmd_Args(void);                                       // @0x33c30 (custom)

int   DFPlayerPreThink(edict_t *player);                          // @0x52150 (custom)
int   DFPlayerPostThink(edict_t *player);                         // @0x52e80 (custom)
int   DFDispatchKeyValue(edict_t *pent, KeyValueData *pkvd);      // @0x52f00 (custom)
int   DFDispatchThink(edict_t *pent);                             // @0x534b0 (custom, stub returns 0)
int   DFDispatchUse(edict_t *pActivator, edict_t *pCaller);       // @0x534c0 (custom, stub returns 0)
int   DFDispatchTouch(edict_t *pToucher, edict_t *pTouched);      // @0x534d0 (custom, stub returns 0)
int   DFDispatchBlocked(edict_t *pBlocked, edict_t *pOther);      // @0x534e0 (custom, stub returns 0)
void  DFServerDeactivate(void);                                   // @0x537d0 (custom, empty)
void  DFServerActivate(edict_t *pEdictList, int edictCount, int clientMax); // @0x537e0 (custom; decompile drops the unused args)
int   DFDispatchSpawn(edict_t *pent);                             // @0x537f0 (custom)

// ======================================================================================
// ---- entity helpers (entfuncs.cpp) ----
// DFGetOrigin/DFGetSize return a Vector by value (decompile shows the sret hidden pointer).
// ======================================================================================

bool  DFMoveableEnt(CBaseEntity *pEntity);                        // @0x48280 (custom)
bool  DFCopyableEnt(CBaseEntity *pEntity);                        // @0x483d0 (custom)
bool  DFMoveableEnt(edict_t *pent);                               // @0x485b0 (custom)
bool  DFCopyableEnt(edict_t *pent);                               // @0x48700 (custom)
Vector DFGetOrigin(edict_t *pent);                                // @0x50ec0 (custom) [ret-by-value]
Vector DFGetSize(edict_t *pent);                                  // @0x50f20 (custom) [ret-by-value]
edict_t *DFFindEntityForward(edict_t *player, float radius, const char *classname,
                             edict_t *ignore, bool movableOnly, bool copyableOnly); // @0x53bd0 (custom)
edict_t *Create(const char *classname, const Vector &origin, const Vector &angles,
                edict_t *owner);                                  // @0x53ea0 (custom)
edict_t *D_GiveNamedItem(edict_t *player, const char *classname); // @0x53fa0 (custom)
edict_t *D_GiveNamedItem2(edict_t *player, const char *classname, const Vector &origin); // @0x54040 (custom)
edict_t *GameCreateEntity(const char *classname);                 // @0x54c80 (custom)
void  GameKeyValue(edict_t *pent, const char *classname, const char *key, const char *value); // @0x54cd0 (custom)
edict_t *AddGameEntity(const char *line);                         // @0x54d90 (custom)
void  DFNoBuildAreas(edict_t *pent, int mode);                    // @0x572f0 (custom)

// ======================================================================================
// ---- beam (beam.cpp): HLSDK CBeam logic ported to free functions over pev ----
// GetStartPos/GetEndPos return a pointer into a vec3 (Ghidra typed it entvars_s*).
// ======================================================================================

void   SetStartEntity(int entindex, entvars_t *pev);              // @0x46a70 (stock: CBeam port)
void   SetEndEntity(int entindex, entvars_t *pev);                // @0x46ab0 (stock: CBeam port)
float *GetStartPos(entvars_t *pev);                               // @0x46af0 (stock: CBeam port)
float *GetEndPos(entvars_t *pev);                                 // @0x46b30 (stock: CBeam port)
void   BeamInit(const char *sprite, int width, entvars_t *pev);   // @0x46b80 (stock: CBeam port)
edict_t *BeamCreate(const char *sprite, int width);               // @0x46c20 (stock: CBeam port)
void   RelinkBeam(entvars_t *pev);                                // @0x46c90 (stock: CBeam port)
void   EntsInit(int startIndex, int endIndex, entvars_t *pev);    // @0x46db0 (stock: CBeam port)
void   PointEntInit(const Vector &start, int endIndex, entvars_t *pev); // @0x46e60 (stock: CBeam port)
void   HoseInit(const Vector &start, const Vector &end, entvars_t *pev); // @0x46ef0 (stock: CBeam port)
void   PointsInit(const Vector &start, const Vector &end, entvars_t *pev); // @0x46f60 (stock: CBeam port)

// ======================================================================================
// ---- entity mover tool (entmover.cpp) ----  (DFEntMover @0x49170 is declared in plugin.h)
// ======================================================================================

void  EntMoverDeploy(edict_t *player);                            // @0x50fa0 (custom)
void  EntMoverAttack(edict_t *player);                            // @0x51040 (custom)
void  EntMoverSpecial(edict_t *player);                           // @0x51420 (custom)
void  EntMoverDestroyEffect(edict_t *player);                     // @0x51950 (custom)
void  EntMoverCreateEffect(edict_t *player);                      // @0x519b0 (custom)
void  EntMoverUpdateEffect(const Vector &start, const Vector &end, edict_t *player); // @0x51b00 (custom)
void  EntMoverContinue(edict_t *player);                          // @0x51b80 (custom)
void  EntMoverOff(edict_t *player);                               // @0x51e30 (custom)
void  EntMoverPrecache(void);                                     // @0x52100 (custom)
// entity-save file replay, factored out of es_load (DFEntMover @0x49170, ~26716-26872); also
// used by the save-preset autoloader. absolute=true: path is the full file path; false: path is
// taken relative to the EntMod entsave directory. Returns the number of entities spawned, -1 if
// the file could not be opened.
int   DFLoadEntFile(const char *path, bool absolute);            // @0x49170 (custom, es_load body)

// ======================================================================================
// ---- admin / entity-save commands (admintools.cpp) ----  (DFEntAdmin @0x46fc0 is in plugin.h)
// ======================================================================================

void  DFPrepareUndo(edict_t *pent);                               // @0x488d0 (custom)
void  KillEntity(edict_t *ent, edict_t *player);                  // @0x48950 (custom)
void  DFEntSave(edict_t *ent, edict_t *player);                   // @0x48b70 (custom)

// Shared entity-tool per-player tables. In the original these are fields of the 0xfd30-byte
// EntInfo3 block (undo ring at +0xc8/+0xcc, es-grab list at +0x20/+0xeb2c); the reconstruction
// holds them as module-local arrays. admintools.cpp (KillEntity/DFPrepareUndo/DFEntSave) is the
// ONE owner that DEFINES them; entmover.cpp (+grabent/-grabent/e_undo, es_start/es_ungrab/es_save
// and EntMoverOff) shares them through these declarations.
#define ES_MAX_UNDO     32    // undo ring: 0x1f live slots + 1 scratch
#define ES_MAX_SELECT   128   // entity-save selection list (cap 0x80)

struct es_undo_t                  // one undo-ring entry (binary stride 0x660)
{
	int      action;          // +0x00  1 = moved, 2 = removed
	Vector   origin;          // +0x04  saved origin
	Vector   angles;          // +0x10  saved angles
	edict_t *ent;             // +0x1c  the affected edict
	char     text[0x600];     // +0x20  saved keyvalue text
	char     classname[0x40]; // +0x620 saved classname
};

struct es_select_t                // one entity-save selection (binary stride 0x24)
{
	int    entindex;          // +0x00
	int    rendermode;        // +0x04  saved pev->rendermode
	float  renderamt;         // +0x08  saved pev->renderamt
	int    renderfx;          // +0x0c  saved pev->renderfx
	Vector rendercolor;       // +0x10  saved pev->rendercolor
	int    effects;           // +0x1c  saved pev->effects
	int    pad;               // +0x20
};

extern int         es_undoCount[ENT_MAXPLAYERS];
extern es_undo_t   es_undo[ENT_MAXPLAYERS][ES_MAX_UNDO];
extern int         es_selectCount[ENT_MAXPLAYERS];
extern es_select_t es_select[ENT_MAXPLAYERS][ES_MAX_SELECT];

// ======================================================================================
// ---- custom weapons (weaponcore.cpp) ----
// ======================================================================================

void  PrimaryAttack(edict_t *player);                             // @0x58360 (custom)
void  PrimaryAttackOff(edict_t *player);                          // @0x583b0 (custom)
void  PrimaryContinue(edict_t *player);                           // @0x58400 (custom)
void  PrimaryIdle(edict_t *player);                               // @0x58450 (custom)
void  PrimaryAlways(edict_t *player);                             // @0x58460 (custom)
void  WeaponPrecache(void);                                       // @0x58470 (custom)
void  WeaponDeploy(edict_t *player);                              // @0x58480 (custom)
void  WeaponHolster(edict_t *player);                             // @0x584d0 (custom)
void  WeaponSpecial(edict_t *player);                             // @0x584e0 (custom)
void  WeaponForceOff(edict_t *player);                            // @0x58520 (custom)
void  WeaponCheck(edict_t *player);                               // @0x58550 (custom)
void  WeaponDisconnect(edict_t *player);                          // @0x58560 (custom)
const char *DFWeaponForId(int weaponId);                          // @0x58600 (custom)
void  DFDefaultDeploy(edict_t *player, const char *viewModel, const char *weaponModel,
                      int anim, const char *animExt, int skiplocal, int body); // @0x58960 (custom)
void  DFSendWeaponAnim(edict_t *player, int anim);                // @0x58a10 (custom)

// ======================================================================================
// ---- util: SDK / engine helpers (util.cpp, expands the existing UTIL_IsValidEntity) ----
// Several return a Vector/TraceResult by value (decompile shows the sret hidden pointer).
// IGNORE_MONSTERS / IGNORE_GLASS are the SDK enums; typed int here (enum header not pulled).
// ======================================================================================

Vector UTIL_VecToAngles(const Vector &vec);                       // @0x545d0 (stock) [ret-by-value]
void   UTIL_TraceLine(const Vector &start, const Vector &end, int ignoreMonsters,
                      int ignoreGlass, edict_t *skip, TraceResult *tr); // @0x54610 (stock, 6-arg glass variant)
                                                                  // (the 5-arg UTIL_TraceLine @0x54650 is the util.h inline)
void   UTIL_MakeVectors(const Vector &angles);                    // @0x54670 (stock)
void   UTIL_MakeAimVectors(const Vector &angles);                 // @0x54680 (stock)
int    UTIL_PointContents(const Vector &vec);                     // @0x546b0 (stock)
void   ClientPrint(entvars_t *client, int msgDest, const char *msgName,
                   const char *p1, const char *p2, const char *p3, const char *p4); // @0x54700 (stock)
void   UTIL_SayText(const char *text, edict_t *to);               // @0x54800 (custom)
bool   IsAlive(edict_t *pent);                                    // @0x54890 (custom)
bool   FInViewCone(const Vector &origin, edict_t *looker);        // @0x548c0 (stock)
bool   FVisible(const Vector &origin, edict_t *looker);           // @0x54980 (stock)
Vector GetGunPosition(edict_t *player);                           // @0x54a70 (stock) [ret-by-value]
Vector VecBModelOrigin(edict_t *pent);                            // @0x54ab0 (stock) [ret-by-value]
void   UTIL_ShowMenu(edict_t *player, int slots, int displayTime, bool needMore, const char *text); // @0x54b00 (custom)
TraceResult UTIL_GetGlobalTrace(void);                            // @0x550e0 (stock) [ret-by-value]
void   VectorRotateX(const Vector &in, float degrees, Vector *out); // @0x55180 (custom)
void   VectorRotateY(const Vector &in, float degrees, Vector *out); // @0x551f0 (custom)
void   VectorRotateZ(const Vector &in, float degrees, Vector *out); // @0x55260 (custom)
void   VectorRotate(const Vector &in, const Vector &angles, Vector *out); // @0x552d0 (custom)
void   UTIL_TraceReflect(const Vector &start, const Vector &end, int ignoreMonsters,
                         int ignoreGlass, edict_t *skip, TraceResult *tr, int depth); // @0x55370 (custom)
void   UTIL_TraceReflect(const Vector &start, const Vector &end, int ignoreMonsters,
                         edict_t *skip, TraceResult *tr, int depth); // @0x55860 (custom)
float  UTIL_WaterLevel(const Vector &position, float minz, float maxz); // @0x55d40 (stock)
void   UTIL_BubbleTrail(const Vector &from, const Vector &to, int count); // @0x55e50 (stock)
edict_t *UTIL_FindEntityInSphere(edict_t *start, const Vector &center, float radius); // @0x55fb0 (stock)
CBaseEntity *UTIL_FindEntityInSphere(CBaseEntity *start, const Vector &center, float radius); // @0x57290 (stock)
void   UTIL_SayTextAll(const char *text, edict_t *from);          // @0x56000 (custom)
void   ClientPrint2(edict_t *player, int msgDest, const char *msg); // @0x56090 (custom)
bool   UTIL_CheckBox(const Vector &mins, const Vector &maxs);     // @0x56230 (custom)
Vector UTIL_TossAngleFromSpeed(const Vector &start, const Vector &end, float speed); // @0x56530 (custom) [ret-by-value]
float  UTIL_TossSpeedFromAngle(const Vector &start, const Vector &end, float angle); // @0x56580 (custom)
Vector UTIL_GetTeamColor(edict_t *pent);                          // @0x56710 (custom) [ret-by-value]
void   UTIL_HudMessage(edict_t *pent, const hudtextparms_s &textparms, const char *message); // @0x56a70 (stock)
void   UTIL_HudMessageAll(const hudtextparms_s &textparms, const char *message); // @0x56dd0 (stock)
bool   IsInWorld(edict_t *pent);                                  // @0x571a0 (stock)
edict_t *UTIL_FindEntityByString(edict_t *start, const char *field, const char *value); // @0x574d0 (stock)
CBaseEntity *UTIL_FindEntityByString(CBaseEntity *start, const char *field, const char *value); // @0x57470 (stock)
edict_t *UTIL_FindEntityByClassname(edict_t *start, const char *name); // @0x57550 (stock)
CBaseEntity *UTIL_FindEntityByClassname(CBaseEntity *start, const char *name); // @0x57520 (stock)
CBaseEntity *UTIL_FindEntityByTargetname(CBaseEntity *start, const char *name); // @0x57580 (stock)
edict_t *UTIL_FindEntityGeneric(const char *name, const Vector &source, float radius); // @0x575b0 (stock)
edict_t *UTIL_PlayerByIndex(int index);                           // @0x57670 (stock)
void   EMIT_SOUND_DYN(edict_t *entity, int channel, const char *sample,
                      float volume, float attenuation, int flags, int pitch); // @0x576b0 (stock)
void   UTIL_ScreenShake(const Vector &center, float amplitude, float frequency,
                        float duration, float radius);            // @0x57770 (stock)
void   UTIL_ScreenShakeAll(const Vector &center, float amplitude, float frequency, float duration); // @0x57970 (stock)
void   UTIL_ScreenFadeBuild(ScreenFade &fade, const Vector &color, float fadeTime,
                            float holdTime, int alpha, int flags); // @0x579b0 (stock)
void   UTIL_ScreenFadeWrite(const ScreenFade &fade, CBaseEntity *pEntity); // @0x57a80 (stock)
void   UTIL_ScreenFadeAll(const Vector &color, float fadeTime, float holdTime, int alpha, int flags); // @0x57b50 (stock)
void   UTIL_ScreenFade(CBaseEntity *pEntity, const Vector &color, float fadeTime,
                       float holdTime, int alpha, int flags);     // @0x57bd0 (stock)
int    GetPlayerIndex(const char *name);                          // @0x544c0 (custom)
edict_t *FindPlayerByName(const char *name);                      // @0x545a0 (custom)
void   MOTDText(edict_t *player, const char *text);               // @0x540d0 (custom)

// ======================================================================================
// ---- util: string helpers (strutil.cpp) ----
// ======================================================================================

int    Q_strncasecmp(const char *a, const char *b, int n);        // @0x54200 (stock)
int    Q_strcasecmp(const char *a, const char *b);                // @0x54270 (stock)
char  *Q_strcasestr(const char *haystack, const char *needle);    // @0x542a0 (stock)
void   FormatLine(char *s);                                       // @0x54fb0 (custom)
char  *StripReturn(char *s);                                      // @0x56e80 (custom)
void   Strings_GetFirstWord(const char *src, char *out);          // @0x56ed0 (custom)
int    Strings_CountWords(const char *src);                       // @0x56f50 (custom)
char  *Strings_GetWord(const char *src, int index);               // @0x57010 (custom)
char  *strLeft(const char *s, int count);                         // @0x58020 (stock)
char  *strrev(char *s);                                           // @0x58080 (stock)
char  *strRight(const char *s, int count);                        // @0x580d0 (stock)
char  *strRemoveReturn(char *s);                                  // @0x58180 (custom)
char  *strTrim(char *s);                                          // @0x58270 (custom)
void   UTIL_StringToVector(float *out, const char *str);          // @0x54bc0 (custom)
void   UTIL_StringToIntArray(int *out, int count, const char *str); // @0x55010 (custom)
void   UTIL_StringSearchReplace(char *str, const char *find, const char *replace); // @0x56180 (custom)

// ======================================================================================
// ---- util: map-cycle parser (mapcycle.cpp) -- stock HL server mapcycle code ----
// ======================================================================================

void   DestroyMapCycle(mapcycle_s *cycle);                        // @0x57c20 (stock)
int    CurrentMap(mapcycle_s *cycle);                             // @0x57c70 (stock)
char  *COM_Parse(char *data);                                     // @0x57cd0 (stock)
int    COM_TokenWaiting(char *buffer);                            // @0x57e20 (stock)
void   ReloadMapCycleFile(const char *filename, mapcycle_s *cycle); // @0x57e80 (stock)
