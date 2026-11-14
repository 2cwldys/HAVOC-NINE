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

// Copies the cvars the shared weapon table carries (h9_mechrocket_clip, _rate, _reload, _salvo and _stagger) into the
// launcher's row, and tells every client the ones that changed (SrvSett ids 5 to 9), because the client's prediction of
// the launcher reads its own copy of the row. Called every rules think, so a change reaches the next give, the next
// reload and the next pull.
void TSMechRocketSyncCvars();

// Tells one client all five (InitHUD: a joiner's table is built from the defaults).
void TSMechRocketTellClient(CBasePlayer *pPlayer);

// h9_mechrocket_nodrop: the launcher is deleted where a drop would have made a world gun.
bool TSMechRocketNoDrop();

// Fires one rocket from pPlayer's eye along vecDir (a unit vector) and plays the launch sound at iPitch. The first rocket
// of a pull goes along vecDir; bFollow marks a later rocket of the salvo, which strays up to h9_mechrocket_spread degrees
// from vecDir and sounds on a channel of its own, so that the launch sounds of one salvo overlap and none cuts the last.
void TSMechRocketLaunch(CBasePlayer *pPlayer, const Vector &vecSrc, const Vector &vecDir, int iPitch, bool bFollow);

#endif // TS_MECHROCKET_H
