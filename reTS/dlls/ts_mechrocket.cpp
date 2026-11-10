/***
*  ts_mechrocket.cpp -- the rocket of the Mech rocket launcher (weapon 41, TSW_MECHROCKET).
*
*  CTSGun::MechRocketFire (ts_gun.cpp) calls TSMechRocketLaunch once per shot. The rocket flies straight at
*  h9_mechrocket_speed with a smoke trail behind it (TE_BEAMFOLLOW) and goes off on the first thing it
*  touches, or when its flight time is up: TSExplosion's blast (h9_mechrocket_damage at the middle, nothing
*  past h9_mechrocket_radius), with the explosion sprite where it lands, and a push (h9_mechrocket_push along
*  the ground, h9_mechrocket_lift up) for the players the blast leaves alive.
*
*  The weapon's art is not part of reTS. Each file is looked up on disk before it is precached (a precache of
*  a file that is not there stops the map), and what is missing is replaced by stock assets.
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "monsters.h"
#include "weapons.h"
#include "player.h"
#include "ts_weapons.h"
#include "ts_utils.h"  // TSExplosion
#include "gamerules.h" // g_pGameRules: who the blast may hurt
#include "game.h"      // the h9_mechrocket cvars
#include "ts_mechrocket.h"

#include <string.h>

static const char *const kViewModel = "models/h9/v_mechrocket.mdl";
static const char *const kPlayerModel = "models/h9/p_mechrocket.mdl";
static const char *const kWorldModel = "models/h9/w_mechrocket.mdl";
static const char *const kRocketModel = "models/h9/mechrocket.mdl"; // optional: the rocket in flight
static const char *const kRocketModelStock = "models/rpgrocket.mdl";
static const char *const kRocketModelLast = "models/shrapnel.mdl"; // the weapon precache list has it already
static const char *const kFlashSprite = "sprites/h9_rocket_flash.spr";
static const char *const kSmokeSprite = "sprites/h9_rocket_smoke.spr";
static const char *const kSmokeSpriteStock = "sprites/steam1.spr";
static const char *const kBoomSprite = "sprites/h9_rocket_boom.spr";
static const char *const kBoomSpriteStock = "sprites/zerogxplode.spr";
static const char *const kLaunchSoundFile = "sound/weapons/rocketfire1.wav";
static const char *const kLaunchSound = "weapons/rocketfire1.wav";

static int s_iSmokeSprite = 0;                      // the trail's model index
static int s_iBoomSprite = 0;                       // the explosion sprite's model index
static const char *s_pszRocketModel = kRocketModelLast; // the rocket's model
static bool s_bLaunchSound = false;                 // the launch sound is on disk and precached

// What is on disk, looked up once for each map (the files are read to find out, and the precache lists that
// call TSMechRocketResolveAssets run again for every player's gun).
static bool s_bChecked = false;
static char s_szCheckedMap[64] = "";
static bool s_bModelsOnDisk = false;
static bool s_bFlashOnDisk = false;
static bool s_bSmokeOnDisk = false;
static bool s_bBoomOnDisk = false;
static bool s_bRocketModelOnDisk = false;
static bool s_bRocketModelStockOnDisk = false;
static bool s_bLaunchSoundOnDisk = false;

// True when the engine finds the file (a loose file in the game folder or in a fallback folder).
static bool FileOnDisk(const char *pszName)
{
	int length = 0;
	byte *pFile = LOAD_FILE_FOR_ME((char *)pszName, &length);
	if (!pFile)
		return false;
	FREE_FILE(pFile);
	return true;
}

void TSMechRocketResolveAssets()
{
	if (!s_bChecked || strcmp(s_szCheckedMap, STRING(gpGlobals->mapname)) != 0)
	{
		s_bChecked = true;
		strncpy(s_szCheckedMap, STRING(gpGlobals->mapname), sizeof(s_szCheckedMap) - 1);
		s_szCheckedMap[sizeof(s_szCheckedMap) - 1] = '\0';
		s_bModelsOnDisk = FileOnDisk(kViewModel) && FileOnDisk(kPlayerModel) && FileOnDisk(kWorldModel);
		s_bFlashOnDisk = FileOnDisk(kFlashSprite);
		s_bSmokeOnDisk = FileOnDisk(kSmokeSprite);
		s_bBoomOnDisk = FileOnDisk(kBoomSprite);
		s_bRocketModelOnDisk = FileOnDisk(kRocketModel);
		s_bRocketModelStockOnDisk = FileOnDisk(kRocketModelStock);
		s_bLaunchSoundOnDisk = FileOnDisk(kLaunchSoundFile);
	}

	// The weapon's three models come together or not at all: without them the row wears the M4A1's models,
	// whose animations it uses.
	s_weapon_info *wi = (s_weapon_info *)get_weapon_info(TSW_MECHROCKET);
	const s_weapon_info *base = get_weapon_info(TSW_M4);
	if (s_bModelsOnDisk)
	{
		wi->pszViewModel = kViewModel;
		wi->pszPlayerModel = kPlayerModel;
		wi->pszWorldModel = kWorldModel;
	}
	else
	{
		wi->pszViewModel = base->pszViewModel;
		wi->pszPlayerModel = base->pszPlayerModel;
		wi->pszWorldModel = base->pszWorldModel;
	}

	// The muzzle flash is a temporary sprite the client finds by name (cl_dll/ev_ts.cpp), which needs the
	// server's precache; without the file the client draws the ordinary muzzle sprite.
	if (s_bFlashOnDisk)
		PRECACHE_MODEL((char *)kFlashSprite);

	s_iSmokeSprite = PRECACHE_MODEL((char *)(s_bSmokeOnDisk ? kSmokeSprite : kSmokeSpriteStock));
	s_iBoomSprite = PRECACHE_MODEL((char *)(s_bBoomOnDisk ? kBoomSprite : kBoomSpriteStock));

	if (s_bRocketModelOnDisk)
		s_pszRocketModel = kRocketModel;
	else if (s_bRocketModelStockOnDisk)
		s_pszRocketModel = kRocketModelStock;
	else
		s_pszRocketModel = kRocketModelLast;
	PRECACHE_MODEL((char *)s_pszRocketModel);

	s_bLaunchSound = s_bLaunchSoundOnDisk;
	if (s_bLaunchSound)
		PRECACHE_SOUND((char *)kLaunchSound);
}

void TSMechRocketSyncCvars()
{
	s_weapon_info *wi = (s_weapon_info *)get_weapon_info(TSW_MECHROCKET);
	const int clip = (int)h9_mechrocket_clip.value;
	wi->iClip = (clip < 1) ? 1 : ((clip > 30) ? 30 : clip);
	const float rate = h9_mechrocket_rate.value;
	wi->flFireRate = (rate < 0.1f) ? 0.1f : rate;
}

bool TSMechRocketNoDrop()
{
	return h9_mechrocket_nodrop.value != 0.0f;
}

//============================================================================
// The blast's push. TS gives a living player no knockback from a hit (combat.cpp, CBaseMonster::TakeDamage), so the
// rocket pushes the players it leaves alive itself: away from the middle of the blast and up, by the falloff of its
// damage (full out to the inner radius, nothing at the outer). Whoever the blast may hurt is pushed -- the game rules
// say who that is, friendly fire off spares a teammate -- and the thrower only when h9_mechrocket_selfdamage is 1. A
// player on a ladder or swimming is left alone, a wall between the blast and the player stops the push as it stops
// the shock, and no push leaves a player faster than kMaxPushSpeed.
//============================================================================
static const float kMaxPushSpeed = 1000.0f;

static void MechRocketPush(const Vector &vecBlast, const Vector &vecFlight, entvars_t *pevRocket, entvars_t *pevOwner,
	float flInner, float flOuter)
{
	const float flPush = h9_mechrocket_push.value;
	const float flLift = h9_mechrocket_lift.value;
	if (flPush <= 0.0f && flLift <= 0.0f)
		return;

	CBaseEntity *pAttacker = (pevOwner && pevOwner != pevRocket) ? CBaseEntity::Instance(pevOwner) : NULL;
	const bool bSelf = h9_mechrocket_selfdamage.value != 0.0f;
	const float flSpan = flOuter - flInner;

	CBaseEntity *pEntity = NULL;
	while ((pEntity = UTIL_FindEntityInSphere(pEntity, vecBlast, flOuter)) != NULL)
	{
		if (!pEntity->IsPlayer() || !pEntity->IsAlive() || pEntity->pev->movetype != MOVETYPE_WALK)
			continue;

		const bool bOwner = pAttacker && pEntity == pAttacker;
		if (bOwner && !bSelf)
			continue;
		if (!bOwner && g_pGameRules && !g_pGameRules->FPlayerCanTakeDamage((CBasePlayer *)pEntity, pAttacker))
			continue;

		const Vector vecTarget = pEntity->Center();
		TraceResult tr;
		UTIL_TraceLine(vecBlast, vecTarget, ignore_monsters, ENT(pevRocket), &tr);
		if (tr.flFraction < 1.0f)
			continue;

		const float flDist = (vecTarget - vecBlast).Length();
		float flFall = 1.0f;
		if (flDist > flInner)
			flFall = (flSpan > 0.0f) ? 1.0f - (flDist - flInner) / flSpan : 0.0f;
		if (flFall <= 0.0f)
			continue;

		// away from the middle of the blast along the ground; a player right on it goes the way the rocket flew
		Vector vecAway = vecTarget - vecBlast;
		vecAway.z = 0.0f;
		if (vecAway.Length() < 1.0f)
			vecAway = vecFlight;
		else
			vecAway = vecAway.Normalize();

		Vector vecVelocity = pEntity->pev->velocity + vecAway * (flPush * flFall);
		vecVelocity.z += flLift * flFall;
		const float flSpeed = vecVelocity.Length();
		if (flSpeed > kMaxPushSpeed)
			vecVelocity = vecVelocity * (kMaxPushSpeed / flSpeed);
		pEntity->pev->velocity = vecVelocity;
		if (flLift > 0.0f)
		{
			// a player lifted off the floor is no longer standing on it
			pEntity->pev->flags &= ~FL_ONGROUND;
			pEntity->pev->groundentity = NULL;
		}
	}
}

//============================================================================
// CMechRocket -- the rocket in flight.
//============================================================================
class CMechRocket : public CBaseEntity
{
public:
	void Spawn() override;
	void EXPORT RocketTouch(CBaseEntity *pOther);
	void EXPORT RocketThink();
	int ObjectCaps() override { return CBaseEntity::ObjectCaps() & ~FCAP_ACROSS_TRANSITION; }

	static CMechRocket *Create(entvars_t *pevOwner, const Vector &vecOrigin, const Vector &vecDir);

private:
	void Detonate();

	bool m_bDetonated = false;
	float m_flDie = 0.0f; // the time it goes off in the air
};

void CMechRocket::Spawn()
{
	pev->classname = MAKE_STRING("h9_mechrocket");
	pev->movetype = MOVETYPE_FLY;
	pev->solid = SOLID_BBOX;
	pev->gravity = 0.0f;
	pev->takedamage = DAMAGE_NO;
	SET_MODEL(ENT(pev), s_pszRocketModel);
	UTIL_SetSize(pev, g_vecZero, g_vecZero);
	UTIL_SetOrigin(pev, pev->origin);

	SetTouch(&CMechRocket::RocketTouch);
	SetThink(&CMechRocket::RocketThink);
	pev->nextthink = gpGlobals->time + 0.1f;
	m_flDie = gpGlobals->time + 10.0f;
}

CMechRocket *CMechRocket::Create(entvars_t *pevOwner, const Vector &vecOrigin, const Vector &vecDir)
{
	CMechRocket *pRocket = GetClassPtr((CMechRocket *)NULL);
	if (!pRocket)
		return NULL;
	pRocket->pev->origin = vecOrigin;
	pRocket->pev->angles = UTIL_VecToAngles(vecDir);
	pRocket->Spawn();
	pRocket->pev->owner = ENT(pevOwner);

	float flSpeed = h9_mechrocket_speed.value;
	if (flSpeed < 100.0f)
		flSpeed = 100.0f;
	else if (flSpeed > 4000.0f)
		flSpeed = 4000.0f;
	pRocket->pev->velocity = vecDir * flSpeed;

	// the smoke trail: a beam that follows the rocket and fades behind it
	MESSAGE_BEGIN(MSG_BROADCAST, SVC_TEMPENTITY);
	WRITE_BYTE(TE_BEAMFOLLOW);
	WRITE_SHORT(pRocket->entindex());
	WRITE_SHORT(s_iSmokeSprite);
	WRITE_BYTE(20);  // life, in tenths of a second
	WRITE_BYTE(6);   // width
	WRITE_BYTE(200); // red
	WRITE_BYTE(200); // green
	WRITE_BYTE(200); // blue
	WRITE_BYTE(200); // brightness
	MESSAGE_END();
	return pRocket;
}

void CMechRocket::RocketTouch(CBaseEntity *pOther)
{
	if (m_bDetonated)
		return;
	if (pOther && pOther->edict() == pev->owner)
		return;

	// the sky is not a target: a rocket that reaches it is gone, with no blast
	const float flSpeed = pev->velocity.Length();
	if (flSpeed > 0.0f)
	{
		const Vector vecAhead = pev->origin + pev->velocity * (8.0f / flSpeed);
		if (UTIL_PointContents(vecAhead) == CONTENTS_SKY)
		{
			m_bDetonated = true;
			SetTouch(nullptr);
			SetThink(nullptr);
			UTIL_Remove(this);
			return;
		}
	}
	Detonate();
}

void CMechRocket::RocketThink()
{
	if (m_bDetonated)
		return;
	if (gpGlobals->time >= m_flDie)
	{
		Detonate();
		return;
	}
	pev->nextthink = gpGlobals->time + 0.1f;
}

void CMechRocket::Detonate()
{
	m_bDetonated = true;
	SetTouch(nullptr);
	SetThink(nullptr);

	// the way the rocket flew along the ground: where a player right on the blast is pushed
	Vector vecFlight = pev->velocity;
	vecFlight.z = 0.0f;
	vecFlight = (vecFlight.Length() > 1.0f) ? vecFlight.Normalize() : g_vecZero;

	// the blast stands off the surface the rocket hit, so that it is not inside the wall
	Vector vecBlast = pev->origin;
	const float flSpeed = pev->velocity.Length();
	if (flSpeed > 0.0f)
	{
		const Vector vecDir = pev->velocity * (1.0f / flSpeed);
		TraceResult tr;
		UTIL_TraceLine(pev->origin - vecDir * 8.0f, pev->origin + vecDir * 24.0f, ignore_monsters, ENT(pev), &tr);
		if (tr.flFraction < 1.0f)
			vecBlast = tr.vecEndPos + tr.vecPlaneNormal * 8.0f;
	}

	float flRadius = h9_mechrocket_radius.value;
	if (flRadius < 1.0f)
		flRadius = 1.0f;

	// the explosion sprite, with no sound, light or particles of its own: TSExplosion's client effect has them
	int iScale = (int)(flRadius * 0.2f);
	if (iScale < 10)
		iScale = 10;
	else if (iScale > 120)
		iScale = 120;
	MESSAGE_BEGIN(MSG_PVS, SVC_TEMPENTITY, vecBlast);
	WRITE_BYTE(TE_EXPLOSION);
	WRITE_COORD(vecBlast.x);
	WRITE_COORD(vecBlast.y);
	WRITE_COORD(vecBlast.z);
	WRITE_SHORT(s_iBoomSprite);
	WRITE_BYTE(iScale); // scale, in tenths
	WRITE_BYTE(15);     // frames a second
	WRITE_BYTE(TE_EXPLFLAG_NOSOUND | TE_EXPLFLAG_NODLIGHTS | TE_EXPLFLAG_NOPARTICLES);
	MESSAGE_END();

	// The thrower is spared its own blast unless h9_mechrocket_selfdamage is on: it is out of the damage
	// test for the length of the call.
	entvars_t *pevOwner = (pev->owner && !pev->owner->free) ? VARS(pev->owner) : pev;
	CBaseEntity *pOwner = (pevOwner != pev) ? CBaseEntity::Instance(pevOwner) : NULL;
	const bool bSpare = pOwner && pOwner->IsPlayer() && h9_mechrocket_selfdamage.value == 0.0f;
	const float flOwnerTakeDamage = bSpare ? pOwner->pev->takedamage : 0.0f;
	if (bSpare)
		pOwner->pev->takedamage = DAMAGE_NO;

	TSExplosion(vecBlast, pev, pevOwner, h9_mechrocket_damage.value, DMG_BLAST | DMG_NEVERGIB, flRadius * 0.25f,
		flRadius);

	if (bSpare)
		pOwner->pev->takedamage = flOwnerTakeDamage;

	// the players the blast leaves alive are pushed (the ones it kills get TS's own death launch)
	MechRocketPush(vecBlast, vecFlight, pev, pevOwner, flRadius * 0.25f, flRadius);

	UTIL_Remove(this);
}

//============================================================================
// TSMechRocketLaunch -- called by CTSGun::MechRocketFire for each shot.
//============================================================================
void TSMechRocketLaunch(CBasePlayer *pPlayer, const Vector &vecSrc, const Vector &vecDir, int iPitch)
{
	// the rocket starts 24 units out along the aim, or at the wall that is nearer
	Vector vecStart = vecSrc + vecDir * 24.0f;
	TraceResult tr;
	UTIL_TraceLine(vecSrc, vecStart, dont_ignore_monsters, ENT(pPlayer->pev), &tr);
	if (tr.flFraction < 1.0f)
		vecStart = tr.vecEndPos - vecDir * 2.0f;

	CMechRocket::Create(pPlayer->pev, vecStart, vecDir);

	if (s_bLaunchSound)
		EMIT_SOUND_DYN(ENT(pPlayer->pev), CHAN_WEAPON, kLaunchSound, VOL_NORM, ATTN_NORM, 0, iPitch);
}
