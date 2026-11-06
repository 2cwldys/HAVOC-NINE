/***
*  ts_bullets.h — the client bullet simulation (client.dll's manager object at 0x100eb678).
*
*  When the server's realbullet setting is on or this client is in slow motion, client.dll's fire
*  core does not trace a round at once: it queues it here, and the round flies at its caliber's
*  speed, lays its impacts where it lands, pierces as the server's bullets do, and is drawn as a
*  pellet sprite while in slow motion (with its trail when cl_wavedetail is above 0).
***/
#pragma once

#include "pm_defs.h"

struct s_weapon_info;

// The fire core's realbullet test (FUN_100450c0, 0x10045193): SrvSett id 0 is not 0, or the
// local slow-motion scale is under 0.99.
bool TSBullets_RealBullet();

// FUN_10035c20: queue a round fired by entity `owner` from `src` along `dir`. Full (256): dropped.
// A plasma round (caliber TS_CALIBER_PLASMA) is drawn from `visualStart` (the muzzle) when one is given, while it
// is simulated from `src`.
void TSBullets_Fire(int owner, const float* src, const float* dir, float damage, int caliber, int mode,
	const float* visualStart = nullptr);

// FUN_10034e60: step and draw every queued round. Called last in HUD_DrawTransparentTriangles.
void TSBullets_Update();

// FUN_10034eb0 / FUN_10034f60: drop every round.
void TSBullets_Reset();

// ev_ts.cpp: the impact, sound and decal of a trace that hit (client.dll FUN_10044bf0 +
// FUN_10001180). The caller has the PM states pushed.
// `caliber` is the caliber of the round that hit: a plasma bolt leaves a scorch and a green glow, not a bullet hole.
void EV_TSBulletHit(int idx, const float* src, const float* end, pmtrace_t& tr, int mode, int caliber = 0);

// The laser rifle's plasma (ts_bullets.cpp). A shot from `from` to where it lands, `to`: a green bolt that runs along it
// and a trail that fades; a faint green light where it was fired from; a green flash and light where it landed.
void TSPlasma_Bolt(const float* from, const float* to);
void TSPlasma_MuzzleLight(int shooter, const float* pos);
void TSPlasma_Impact(const float* pos);
