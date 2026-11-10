/***
*  ts_mechrocket.h -- the Mech rocket launcher (weapon 41, TSW_MECHROCKET): the rocket entity and the
*  server-side helpers CTSGun and the precache lists call. Server only.
***/
#ifndef TS_MECHROCKET_H
#define TS_MECHROCKET_H

class CBasePlayer;
class Vector;

// Looks up the weapon's art on disk and precaches what is there; whatever is missing is replaced by stock
// assets (the M4A1's models for the weapon, Half-Life's rocket model, smoke and explosion sprites). Safe to
// call any number of times: it runs in both weapon precache lists and gives the same answer each time.
void TSMechRocketResolveAssets();

// Copies the cvars the shared weapon table carries (h9_mechrocket_clip, h9_mechrocket_rate) into the
// launcher's row. Called every rules think, so a change reaches the next give and the next reload.
void TSMechRocketSyncCvars();

// h9_mechrocket_nodrop: the launcher is deleted where a drop would have made a world gun.
bool TSMechRocketNoDrop();

// Fires one rocket from pPlayer's eye along vecDir (a unit vector) and plays the launch sound at iPitch.
void TSMechRocketLaunch(CBasePlayer *pPlayer, const Vector &vecSrc, const Vector &vecDir, int iPitch);

#endif // TS_MECHROCKET_H
