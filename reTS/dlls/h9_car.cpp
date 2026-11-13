/***
*  h9_car.cpp -- h9_car, a car a player drives (H9; vehicles/DESIGN.md in h9-maps, phase 1).
*
*  A point entity with a studio model. A player who presses +use on it takes the wheel: he is hidden and held
*  inside it, his weapons are put away, and he sees the car from a camera that follows it. W and S drive and
*  brake, A and D steer, jump is the handbrake, +use gets out beside the car, and R held a second puts a stuck car
*  back where it last stood on four wheels touching nothing.
*
*  The car is an arcade car, not a rigid body (the method of Diffusion's func_car, written anew here): its speed
*  is one number, its steering one angle, and it turns about its rear axle as a bicycle does (yaw rate = speed *
*  tan(steer) / wheelbase). Each frame it moves itself: a hull trace and four bumper traces stop it at walls (it
*  slides along one it meets at a slant), and four traces down, one under each wheel, set its height, its pitch
*  and its roll. A rise the wheels cannot climb (more than "maxstep") is a wall. With no wheel on the ground it
*  falls. Gravity along the slope slows it uphill.
*
*  It takes the player's controls through CBasePlayer::m_pTank, the hook func_tank uses: while it is set the
*  player's weapons do nothing (ItemPostFrame), his death and his respawn call Use(USE_OFF), and every PostThink
*  asks OnControls() whether he is still at the wheel (Use(USE_SET, 2)). So nothing in player.cpp changes.
*  TS calls PlayerUse from ImpulseCommands, inside ItemPostFrame, which returns at once while m_pTank is set: the
*  player code never sees +use in the car, so the car reads it itself (a press, after the one that got him in).
*  While he drives, the driver is SOLID_NOT and the car is his owner, so that the car's traces pass through him
*  (he rides inside it, and TS gives a player back his solid each frame).
*
*  The model's bone controllers 0 and 1 turn the left and the right front wheel (degrees of steer: one controller
*  turns one bone), and its sequence 0 rolls every wheel once a cycle: it is played at the wheels' turns a second,
*  backwards when the car reverses. A model with neither still drives (h9-maps art/h9-car.mjs makes car.mdl so).
*
*  Keys (units are Half-Life's; speeds in units a second):
*    model          the studio model (default models/h9/car.mdl); a car whose model is not on disk is removed
*    maxspeed 900   backspeed 300   accel 450   brake 1200   coast 150 (the slowing with nothing pressed)
*    maxturn 35     (the front wheels' greatest angle, degrees)   turnrate 150 (degrees a second)
*    frontdist 75   reardist 75   (the axles from the origin)   track 88 (between the wheels of one axle)
*    length 200   width 100   height 64   (the body, for collision; the origin is on the ground, at the middle)
*    radius 20      (the wheels')   maxstep 12 (the highest rise the wheels climb)
*    enginesnd      the engine's loop (default plats/ttrain2.wav, pitched by speed)
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "monsters.h"
#include "weapons.h"
#include "player.h"

#include <math.h>

#define H9CAR_GRAVITY 800.0f   // sv_gravity's default: the fall, and the pull along a slope
#define H9CAR_CRAWL 20.0f      // under this speed the car counts as standing still
#define H9CAR_SLOPE 3.0f       // degrees: a gentler slope does not roll the car
#define H9CAR_PUSH 25.0f       // the least speed while pushed into a wall, so it slides along it
#define H9CAR_RESET_HOLD 1.0f  // seconds R is held to put a stuck car back at its last safe place
#define H9CAR_EXIT_GAP 24.0f   // between the body and the player who gets out
#define H9CAR_CAM_BACK 300.0f  // the camera, behind the car
#define H9CAR_CAM_UP 110.0f    // and above its origin
#define H9CAR_CAM_LOOK 40.0f   // it looks at this height over the origin

static float H9Approach(float target, float value, float step)
{
	if (value < target)
		return value + step < target ? value + step : target;
	return value - step > target ? value - step : target;
}

static float H9Clamp(float value, float low, float high)
{
	return value < low ? low : (value > high ? high : value);
}

//=========================================================
// The camera a driver looks through: an entity with the car's model drawn fully transparent (an entity with no
// model, or one marked EF_NODRAW, is not sent to the client, and SET_VIEW needs it sent), placed by the car.
//=========================================================
class CH9CarCamera : public CBaseEntity
{
public:
	void Spawn() override
	{
		pev->classname = MAKE_STRING("h9_car_camera");
		pev->movetype = MOVETYPE_NOCLIP;
		pev->solid = SOLID_NOT;
		pev->rendermode = kRenderTransTexture;
		pev->renderamt = 0;
		pev->takedamage = DAMAGE_NO;
	}
	int ObjectCaps() override { return FCAP_DONT_SAVE; }
};
LINK_ENTITY_TO_CLASS(h9_car_camera, CH9CarCamera);

//=========================================================
// The car.
//=========================================================
class CH9Car : public CBaseAnimating
{
public:
	void Spawn() override;
	void Precache() override;
	bool KeyValue(KeyValueData* pkvd) override;
	int ObjectCaps() override { return (CBaseAnimating::ObjectCaps() & ~FCAP_ACROSS_TRANSITION) | FCAP_IMPULSE_USE; }
	void Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value) override;
	bool OnControls(entvars_t* pevTest) override;

	void EXPORT DriveThink();
	void Step(const char* by);

private:
	CBasePlayer* Driver();
	void TakeWheel(CBasePlayer* pPlayer);
	void LeaveWheel(CBasePlayer* pPlayer);
	bool ExitSpot(CBasePlayer* pPlayer, Vector& spot);
	void Steer(CBasePlayer* pDriver, float dt);
	bool Move(float dt);
	bool Blocked(const Vector& from, const Vector& move, TraceResult& hit);
	void Settle(float dt);
	void PlaceCamera(float dt);
	void FitBox();
	void Sound();

	// tuning (keys)
	float m_flMaxSpeed = 900, m_flBackSpeed = 300, m_flAccel = 450, m_flBrake = 1200, m_flCoast = 150;
	float m_flMaxTurn = 35, m_flTurnRate = 150;
	float m_flFrontDist = 75, m_flRearDist = 75, m_flTrack = 88;
	float m_flLength = 200, m_flWidth = 100, m_flHeight = 64;
	float m_flRadius = 20, m_flMaxStep = 12;
	string_t m_iszEngine = 0;

	// state
	EHANDLE m_hDriver;
	EHANDLE m_hCamera;
	float m_flSpeed = 0;     // along the car's heading; negative backwards
	float m_flSteer = 0;     // the front wheels, degrees, positive to the left
	float m_flYaw = 0;       // the heading
	float m_flPitch = 0;     // nose up, degrees
	float m_flRoll = 0;
	float m_flFall = 0;      // the vertical speed while off the ground (negative down)
	float m_flLastThink = 0;
	float m_flNextSound = 0;
	bool m_bEngineOn = false;
	bool m_bGrounded = true;
	int m_iLastButtons = 0; // the driver's, the command before: a +use press gets him out
	bool m_bUsePressed = false;
	float m_flLastDt = 0;
	int m_iPush = 0;           // the driver's throttle: 1 W, -1 S, 0 neither
	bool m_bAllWheels = true;  // all four wheels on the ground, the last Settle
	Vector m_vecSafe = g_vecZero; // the last place it stood on four wheels, touching nothing (R held puts it back)
	float m_flSafeYaw = 0;
	bool m_bHasSafe = false;
	Vector m_vecPending = g_vecZero; // a place on its way to becoming the safe one
	float m_flPendingYaw = 0, m_flPendingAt = 0;
	bool m_bPending = false;
	float m_flResetHeld = 0;   // seconds R has been held
	float m_flEntered = 0;
	float m_flNextReport = 0; // developer 1: what the car sees, twice a second
	float m_flLastHit = 1;
	int m_iHitBy = -1, m_iLastHitBy = -1; // which trace stopped it: 0 the hull, 1-6 the bumper rays
	float m_flLastHitTime = -1;
	char m_szLastHit[32] = "";
	float m_flWheelGround[4] = {0, 0, 0, 0}; // each wheel's ground, the frame before: its trace starts over it
	float m_flFrontGround = 0, m_flRearGround = 0; // under each axle: the bumper rays go at a height over it
};
LINK_ENTITY_TO_CLASS(h9_car, CH9Car);

bool CH9Car::KeyValue(KeyValueData* pkvd)
{
	struct Key
	{
		const char* name;
		float* value;
	};
	const Key keys[] = {
		{"maxspeed", &m_flMaxSpeed}, {"backspeed", &m_flBackSpeed}, {"accel", &m_flAccel}, {"brake", &m_flBrake},
		{"coast", &m_flCoast}, {"maxturn", &m_flMaxTurn}, {"turnrate", &m_flTurnRate}, {"frontdist", &m_flFrontDist},
		{"reardist", &m_flRearDist}, {"track", &m_flTrack}, {"length", &m_flLength}, {"width", &m_flWidth},
		{"height", &m_flHeight}, {"radius", &m_flRadius}, {"maxstep", &m_flMaxStep},
	};
	for (const Key& key : keys)
	{
		if (FStrEq(pkvd->szKeyName, key.name))
		{
			*key.value = atof(pkvd->szValue);
			return true;
		}
	}
	if (FStrEq(pkvd->szKeyName, "enginesnd"))
	{
		m_iszEngine = ALLOC_STRING(pkvd->szValue);
		return true;
	}
	return CBaseAnimating::KeyValue(pkvd);
}

// True when the engine finds the file in the game folder or a fallback folder (a precache of a missing file
// stops the map).
static bool H9FileOnDisk(const char* name)
{
	int length = 0;
	byte* file = LOAD_FILE_FOR_ME((char*)name, &length);
	if (!file)
		return false;
	FREE_FILE(file);
	return true;
}

void CH9Car::Precache()
{
	if (FStringNull(pev->model))
		pev->model = MAKE_STRING("models/h9/car.mdl");
	if (FStringNull(m_iszEngine))
		m_iszEngine = MAKE_STRING("plats/ttrain2.wav");
	if (H9FileOnDisk(STRING(pev->model)))
		PRECACHE_MODEL((char*)STRING(pev->model));
	PRECACHE_SOUND((char*)STRING(m_iszEngine));
	PRECACHE_SOUND("plats/ttrain_start1.wav");
	PRECACHE_SOUND("plats/ttrain_brake1.wav");
	PRECACHE_SOUND("plats/vehicle_ignition.wav");
	PRECACHE_SOUND("debris/metal2.wav");
}

void CH9Car::Spawn()
{
	Precache();
	if (!H9FileOnDisk(STRING(pev->model)))
	{
		ALERT(at_error, "h9_car at %.0f %.0f %.0f: its model %s is not on disk; removed\n", pev->origin.x,
			pev->origin.y, pev->origin.z, STRING(pev->model));
		UTIL_Remove(this);
		return;
	}
	SET_MODEL(edict(), STRING(pev->model));
	pev->movetype = MOVETYPE_NONE; // it moves itself, in DriveThink
	pev->solid = SOLID_BBOX;
	pev->takedamage = DAMAGE_NO;
	pev->sequence = 0;
	ResetSequenceInfo();
	pev->frame = 0;
	pev->framerate = 0;
	m_flYaw = pev->angles.y;
	for (float& z : m_flWheelGround)
		z = pev->origin.z;
	m_flFrontGround = m_flRearGround = pev->origin.z;
	m_flMaxTurn = H9Clamp(m_flMaxTurn, 1, 60);
	m_flMaxStep = H9Clamp(m_flMaxStep, 0, 32);
	FitBox();
	Settle(0);
	m_vecSafe = pev->origin; // where the mapper put it is the first safe place
	m_flSafeYaw = m_flYaw;
	m_bHasSafe = true;
	m_flLastThink = gpGlobals->time;
	SetThink(&CH9Car::DriveThink);
	pev->nextthink = gpGlobals->time + 0.1;
}

CBasePlayer* CH9Car::Driver()
{
	CBaseEntity* pEntity = m_hDriver;
	if (!pEntity || !pEntity->IsPlayer())
		return NULL;
	return static_cast<CBasePlayer*>(pEntity);
}

// The player's PostThink asks this every frame while m_pTank is the car: false lets him go (Use(USE_OFF)).
bool CH9Car::OnControls(entvars_t* pevTest)
{
	CBasePlayer* pDriver = Driver();
	return pDriver && pDriver->pev == pevTest;
}

void CH9Car::Use(CBaseEntity* pActivator, CBaseEntity* pCaller, USE_TYPE useType, float value)
{
	if (!pActivator || !pActivator->IsPlayer())
		return;
	CBasePlayer* pPlayer = static_cast<CBasePlayer*>(pActivator);
	CBasePlayer* pDriver = Driver();

	if (useType == USE_OFF) // +use while driving, death, respawn: the player code clears m_pTank after this
	{
		if (pPlayer == pDriver)
			LeaveWheel(pPlayer);
		return;
	}
	// The per-frame "still at the controls" call. It runs at the client's clock (Xash's SV_RunCmd sets
	// gpGlobals->time to the client's timebase for PlayerPostThink), not the server's, so the car must not step on
	// it: a dt taken across the two clocks comes out negative or zero for whole seconds. It only keeps a +use press,
	// which a short tap could make and undo between two of the car's thinks.
	if (useType == USE_SET && value == 2)
	{
		if (pPlayer == pDriver)
		{
			const int buttons = pPlayer->pev->button;
			if ((buttons & IN_USE) && !(m_iLastButtons & IN_USE))
				m_bUsePressed = true;
			m_iLastButtons = buttons;
		}
		return;
	}
	if (pDriver || !pPlayer->IsAlive() || pPlayer->m_pTank != NULL)
		return;
	TakeWheel(pPlayer);
}

void CH9Car::TakeWheel(CBasePlayer* pPlayer)
{
	m_hDriver = pPlayer;
	pPlayer->m_pTank = this;
	if (pPlayer->m_pActiveItem)
		pPlayer->m_pActiveItem->Holster();
	pPlayer->pev->weaponmodel = 0;
	pPlayer->pev->viewmodel = 0;
	pPlayer->m_iHideHUD |= HIDEHUD_WEAPONS;
	// Not FL_FROZEN (EnableControl(false)): Xash's SV_ParseClientMove zeroes a frozen player's buttons, and the car
	// drives on them. He is held by being put back inside the car every frame instead.
	pPlayer->pev->effects |= EF_NODRAW;
	pPlayer->pev->solid = SOLID_NOT;
	pPlayer->pev->movetype = MOVETYPE_NOCLIP;
	pPlayer->pev->velocity = g_vecZero;
	pPlayer->pev->takedamage = DAMAGE_NO;
	pPlayer->pev->owner = edict(); // the car's traces pass through him
	UTIL_SetOrigin(pPlayer->pev, pev->origin + Vector(0, 0, 40));
	m_iLastButtons = pPlayer->pev->button;
	m_bUsePressed = false;
	m_flEntered = gpGlobals->time;

	if (!m_hCamera)
	{
		CBaseEntity* pCamera = GetClassPtr((CH9CarCamera*)NULL);
		pCamera->Spawn();
		SET_MODEL(pCamera->edict(), STRING(pev->model));
		UTIL_SetSize(pCamera->pev, g_vecZero, g_vecZero);
		m_hCamera = pCamera;
	}
	PlaceCamera(0);
	SET_VIEW(pPlayer->edict(), m_hCamera->edict());
	pPlayer->m_hViewEntity = m_hCamera;

	ClientPrint(pPlayer->pev, HUD_PRINTCENTER, "W/S drive, A/D steer, jump brakes, use gets out\nstuck? hold R");
	EMIT_SOUND_DYN(edict(), CHAN_ITEM, "plats/vehicle_ignition.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
	EMIT_SOUND_DYN(edict(), CHAN_STATIC, STRING(m_iszEngine), 0.6, ATTN_NORM, 0, 70);
	m_bEngineOn = true;
	m_flLastThink = gpGlobals->time;
	pev->nextthink = gpGlobals->time;
}

// Beside the car, left or right, then behind, ahead, and on its roof: the first place a standing player fits.
bool CH9Car::ExitSpot(CBasePlayer* pPlayer, Vector& spot)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float side = m_flWidth / 2 + 16 + H9CAR_EXIT_GAP;
	const float back = m_flLength / 2 + 16 + H9CAR_EXIT_GAP;
	const Vector stand = Vector(0, 0, 37); // a standing player's origin over the floor
	const Vector spots[] = {
		pev->origin - right * side + stand,
		pev->origin + right * side + stand,
		pev->origin - forward * back + stand,
		pev->origin + forward * back + stand,
		pev->origin + Vector(0, 0, m_flHeight + 1) + stand,
	};
	for (const Vector& candidate : spots)
	{
		TraceResult tr;
		UTIL_TraceHull(candidate, candidate, dont_ignore_monsters, human_hull, edict(), &tr);
		if (!tr.fAllSolid && !tr.fStartSolid)
		{
			spot = candidate;
			return true;
		}
	}
	return false;
}

void CH9Car::LeaveWheel(CBasePlayer* pPlayer)
{
	Vector spot;
	if (!ExitSpot(pPlayer, spot))
		spot = pev->origin + Vector(0, 0, m_flHeight + 38); // on the roof, the last resort
	pPlayer->pev->effects &= ~EF_NODRAW;
	if (pPlayer->pev->owner == edict())
		pPlayer->pev->owner = NULL;
	pPlayer->pev->solid = SOLID_SLIDEBOX;
	pPlayer->pev->movetype = MOVETYPE_WALK;
	pPlayer->pev->velocity = g_vecZero;
	pPlayer->EnableControl(true);
	UTIL_SetOrigin(pPlayer->pev, spot);
	if (pPlayer->IsAlive())
	{
		pPlayer->pev->takedamage = DAMAGE_AIM;
		pPlayer->pev->angles = Vector(0, m_flYaw, 0);
		pPlayer->pev->v_angle = pPlayer->pev->angles;
		pPlayer->pev->fixangle = 1;
		pPlayer->m_iHideHUD &= ~HIDEHUD_WEAPONS;
		pPlayer->EquipWeapon();
	}
	SET_VIEW(pPlayer->edict(), pPlayer->edict());
	pPlayer->m_hViewEntity = NULL;
	m_hDriver = NULL;
	STOP_SOUND(edict(), CHAN_STATIC, STRING(m_iszEngine));
	m_bEngineOn = false;
}

// Throttle, brake and steering from the driver's buttons; the steering eases back when let go.
void CH9Car::Steer(CBasePlayer* pDriver, float dt)
{
	const int buttons = pDriver ? pDriver->pev->button : 0;
	const bool ahead = (buttons & IN_FORWARD) != 0, back = (buttons & IN_BACK) != 0;
	const bool left = (buttons & IN_MOVELEFT) != 0, right = (buttons & IN_MOVERIGHT) != 0;
	const bool handbrake = (buttons & IN_JUMP) != 0;
	m_iPush = ahead == back ? 0 : (ahead ? 1 : -1);

	// A crawl (under H9CAR_CRAWL) counts as standing still when choosing between braking and driving off: otherwise a
	// speed a hair over 0 (the slope's pull on a floor read at -0.001 degrees) is braked to 0 every frame, the pull
	// puts the hair back, and S (or W) never reverses it.
	if (ahead && !back)
		m_flSpeed = m_flSpeed < -H9CAR_CRAWL ? H9Approach(0, m_flSpeed, m_flBrake * dt) : (m_flSpeed < 0 ? 0 : m_flSpeed) + m_flAccel * dt * (1 - (m_flSpeed > 0 ? m_flSpeed : 0) / m_flMaxSpeed);
	else if (back && !ahead)
		m_flSpeed = m_flSpeed > H9CAR_CRAWL ? H9Approach(0, m_flSpeed, m_flBrake * dt) : (m_flSpeed > 0 ? 0 : m_flSpeed) - m_flAccel * dt;
	else
	{
		m_flSpeed = H9Approach(0, m_flSpeed, m_flCoast * dt);
		if (fabsf(m_flSpeed) < H9CAR_CRAWL) // let go, it stops (Diffusion: under 20)
			m_flSpeed = 0;
	}
	if (handbrake)
		m_flSpeed = H9Approach(0, m_flSpeed, m_flBrake * 0.6f * dt);
	// gravity along the slope (uphill slows, downhill speeds up), only on a real slope: a floor read a hair off level
	// must not push (Diffusion lets a slope roll the car only past 10 degrees)
	if (m_bGrounded && fabsf(m_flPitch) > H9CAR_SLOPE)
		m_flSpeed -= H9CAR_GRAVITY * sinf(m_flPitch * (M_PI / 180)) * dt;
	m_flSpeed = H9Clamp(m_flSpeed, -m_flBackSpeed, m_flMaxSpeed);

	// less lock at speed, as a driver gives it
	const float lock = m_flMaxTurn * (1 - 0.45f * H9Clamp(fabsf(m_flSpeed) / m_flMaxSpeed, 0, 1));
	const float target = left == right ? 0 : (left ? lock : -lock);
	m_flSteer = H9Approach(target, m_flSteer, m_flTurnRate * (target == 0 ? 1.5f : 1.0f) * dt);

	if (m_bGrounded)
	{
		const float wheelbase = m_flFrontDist + m_flRearDist > 1 ? m_flFrontDist + m_flRearDist : 1;
		float yawRate = m_flSpeed * tanf(m_flSteer * (M_PI / 180)) / wheelbase * (180 / M_PI);
		if (handbrake && fabsf(m_flSpeed) > 200)
			yawRate *= 1.5f; // the rear lets go
		m_flYaw = UTIL_AngleMod(m_flYaw + yawRate * dt);
	}
}

// Whether the car, standing at `from`, would hit something on `move`: a hull trace through its middle and line
// traces from the corners that lead, at a wheel's climb over the ground and at the body's middle.
bool CH9Car::Blocked(const Vector& from, const Vector& move, TraceResult& hit)
{
	memset(&hit, 0, sizeof(hit));
	hit.flFraction = 1;
	m_iHitBy = -1;
	if (move.Length() < 0.001f)
		return false;
	const Vector way = move.Normalize();
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float ahead = DotProduct(move, forward) >= 0 ? 1 : -1;
	const Vector lead = move.Normalize() * 4; // a margin, so it stops short of the wall rather than in it

	TraceResult tr;
	// a hull through the middle, its foot well over the wheels' climb (a slope rises under its ends); one that starts
	// in something (a wall it already touches on a turn) says nothing, and the rays below do the work
	const Vector lift = Vector(0, 0, 32 + m_flMaxStep + 12); // large_hull is 64 tall, centred
	UTIL_TraceHull(from + lift, from + lift + move, dont_ignore_monsters, large_hull, edict(), &tr);
	if (!tr.fStartSolid && tr.flFraction < hit.flFraction && DotProduct(tr.vecPlaneNormal, way) < -0.1f)
	{
		hit = tr;
		m_iHitBy = 0;
	}

	const float halfLength = m_flLength / 2, halfWidth = m_flWidth / 2;
	// the rays at heights over the ground under the leading axle, so that they follow a slope instead of meeting it
	const float base = (ahead > 0 ? m_flFrontGround : m_flRearGround) - from.z;
	const float heights[] = {base + m_flMaxStep + 2, base + m_flHeight / 2};
	for (int level = 0; level < 2; level++)
	{
		const float z = heights[level];
		for (int side = -1; side <= 1; side++)
		{
			const Vector corner = from + forward * (halfLength * ahead) + right * (halfWidth * side * 0.95f) + Vector(0, 0, z);
			UTIL_TraceLine(corner, corner + move + lead, dont_ignore_monsters, edict(), &tr);
			// a ray that starts inside something (a bumper already in a ramp's side) or meets a face it moves away from
			// says nothing: only a face that stands against the way it goes stops it
			if (!tr.fStartSolid && !tr.fAllSolid && tr.flFraction < hit.flFraction && DotProduct(tr.vecPlaneNormal, way) < -0.1f)
			{
				hit = tr;
				m_iHitBy = 1 + level * 3 + (side + 1); // 1-3 the low rays (left, middle, right), 4-6 the high ones
			}
		}
	}
	return hit.flFraction < 1;
}

// One frame's travel along the heading, sliding along a wall met at a slant. True when it hit something.
bool CH9Car::Move(float dt)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	Vector move = gpGlobals->v_forward * (m_flSpeed * dt);
	TraceResult hit;
	const bool blocked = Blocked(pev->origin, move, hit);
	if (blocked) // the last real stop, kept for the report
	{
		m_flLastHit = hit.flFraction;
		m_iLastHitBy = m_iHitBy;
		snprintf(m_szLastHit, sizeof(m_szLastHit), "%s", hit.pHit ? STRING(hit.pHit->v.classname) : "?");
		m_flLastHitTime = gpGlobals->time;
	}
	if (!blocked)
	{
		UTIL_SetOrigin(pev, pev->origin + move);
		return false;
	}
	// up to where it hit, then what is left of the move along the wall
	const float speedBefore = fabsf(m_flSpeed);
	Vector normal = hit.vecPlaneNormal;
	normal.z = 0;
	if (normal.Length() < 0.01f)
		normal = -move.Normalize();
	normal = normal.Normalize();
	const float headOn = fabsf(DotProduct(move.Normalize(), normal));
	const int way = m_flSpeed > 0 ? 1 : -1;
	m_flSpeed *= (1 - headOn);
	// still pushed the way it went: it keeps a crawl, so that it goes on sliding along the wall instead of sticking to
	// it (Diffusion's "in case if stuck": 25)
	if (m_iPush == way && fabsf(m_flSpeed) < H9CAR_PUSH)
		m_flSpeed = H9CAR_PUSH * way;
	Vector slide = move * (1 - hit.flFraction);
	slide = slide - normal * DotProduct(slide, normal);
	TraceResult again;
	if (slide.Length() > 0.1f && !Blocked(pev->origin, slide, again))
		UTIL_SetOrigin(pev, pev->origin + slide);
	if (speedBefore - fabsf(m_flSpeed) > 300)
		EMIT_SOUND_DYN(edict(), CHAN_BODY, "debris/metal2.wav", 1, ATTN_NORM, 0, 90 + RANDOM_LONG(0, 20));
	return true;
}

// The wheels on the ground: four traces down set the height, the pitch and the roll; with none it falls.
void CH9Car::Settle(float dt)
{
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector forward = gpGlobals->v_forward, right = gpGlobals->v_right;
	const float along[4] = {m_flFrontDist, m_flFrontDist, -m_flRearDist, -m_flRearDist};
	const float across[4] = {-m_flTrack / 2, m_flTrack / 2, -m_flTrack / 2, m_flTrack / 2}; // left, right
	float ground[4];
	bool touching[4];
	int count = 0;
	float sum = 0;
	for (int i = 0; i < 4; i++)
	{
		Vector wheel = pev->origin + forward * along[i] + right * across[i];
		wheel.z = m_flWheelGround[i]; // from its own ground: on a slope a wheel is well above or below the middle
		TraceResult tr;
		UTIL_TraceLine(wheel + Vector(0, 0, m_flMaxStep + 1), wheel - Vector(0, 0, m_flRadius * 2 + 8), ignore_monsters,
			edict(), &tr);
		touching[i] = tr.flFraction < 1 && !tr.fStartSolid;
		ground[i] = touching[i] ? tr.vecEndPos.z : pev->origin.z - m_flRadius;
		if (touching[i])
		{
			sum += ground[i];
			count++;
		}
	}

	Vector origin = pev->origin;
	m_bGrounded = count > 0;
	m_bAllWheels = count == 4;
	if (!m_bGrounded)
	{
		m_flFall -= H9CAR_GRAVITY * dt;
		origin.z += m_flFall * dt;
	}
	else
	{
		const float floor = sum / count;
		if (origin.z > floor + 1 && dt > 0) // above its wheels' ground: it falls onto it
		{
			m_flFall -= H9CAR_GRAVITY * dt;
			origin.z += m_flFall * dt;
			if (origin.z <= floor)
			{
				origin.z = floor;
				if (m_flFall < -350)
				{
					m_flSpeed *= 0.8f;
					EMIT_SOUND_DYN(edict(), CHAN_BODY, "plats/ttrain_brake1.wav", 0.7, ATTN_NORM, 0, 120);
				}
				m_flFall = 0;
			}
		}
		else
		{
			origin.z = floor;
			m_flFall = 0;
		}
		const float wheelbase = m_flFrontDist + m_flRearDist > 1 ? m_flFrontDist + m_flRearDist : 1;
		const float track = m_flTrack > 1 ? m_flTrack : 1;
		const float pitch = atan2f((ground[0] + ground[1]) / 2 - (ground[2] + ground[3]) / 2, wheelbase) * (180 / M_PI);
		const float roll = atan2f((ground[1] + ground[3]) / 2 - (ground[0] + ground[2]) / 2, track) * (180 / M_PI);
		const float ease = dt > 0 ? H9Clamp(dt * 10, 0, 1) : 1;
		m_flPitch += (pitch - m_flPitch) * ease;
		m_flRoll += (roll - m_flRoll) * ease;
	}
	UTIL_SetOrigin(pev, origin);
	pev->angles = Vector(m_flPitch, m_flYaw, m_flRoll);
	// the next frame's wheel traces start over these; a wheel in the air hangs from the body
	for (int i = 0; i < 4; i++)
		m_flWheelGround[i] = touching[i] ? ground[i] : origin.z;
	m_flFrontGround = (m_flWheelGround[0] + m_flWheelGround[1]) / 2;
	m_flRearGround = (m_flWheelGround[2] + m_flWheelGround[3]) / 2;
}

// The bounding box: a box stays square to the world in the engine, so it is the one that holds the turned body.
void CH9Car::FitBox()
{
	const float c = fabsf(cosf(m_flYaw * (M_PI / 180))), s = fabsf(sinf(m_flYaw * (M_PI / 180)));
	const float hx = c * m_flLength / 2 + s * m_flWidth / 2;
	const float hy = s * m_flLength / 2 + c * m_flWidth / 2;
	UTIL_SetSize(pev, Vector(-hx, -hy, 0), Vector(hx, hy, m_flHeight));
}

// Behind and above the car, catching up with it (it lags on a turn, so the car is seen turning), looking at it.
void CH9Car::PlaceCamera(float dt)
{
	CBaseEntity* pCamera = m_hCamera;
	if (!pCamera)
		return;
	UTIL_MakeVectors(Vector(0, m_flYaw, 0));
	const Vector look = pev->origin + Vector(0, 0, H9CAR_CAM_LOOK);
	Vector goal = pev->origin - gpGlobals->v_forward * H9CAR_CAM_BACK + Vector(0, 0, H9CAR_CAM_UP);
	TraceResult tr; // never behind a wall
	UTIL_TraceLine(look, goal, ignore_monsters, edict(), &tr);
	goal = look + (goal - look) * (tr.flFraction > 0.1f ? tr.flFraction - 0.05f : 0.05f);
	const float ease = dt > 0 ? H9Clamp(dt * 6, 0, 1) : 1;
	const Vector at = pCamera->pev->origin + (goal - pCamera->pev->origin) * ease;
	UTIL_SetOrigin(pCamera->pev, at);
	Vector angles = UTIL_VecToAngles(look - at);
	angles.x = -angles.x; // a view's pitch is the other way round
	pCamera->pev->angles = angles;
	pCamera->pev->v_angle = angles;
}

// The engine's pitch follows the speed.
void CH9Car::Sound()
{
	if (!m_bEngineOn || gpGlobals->time < m_flNextSound)
		return;
	m_flNextSound = gpGlobals->time + 0.1f;
	const int pitch = 70 + (int)(90 * H9Clamp(fabsf(m_flSpeed) / m_flMaxSpeed, 0, 1));
	EMIT_SOUND_DYN(edict(), CHAN_STATIC, STRING(m_iszEngine), 0.6, ATTN_NORM, SND_CHANGE_PITCH | SND_CHANGE_VOL, pitch);
}

void CH9Car::DriveThink()
{
	Step("think");
	CBasePlayer* pDriver = Driver();
	// every frame while it moves or is driven; at rest, ten times a second
	const bool resting = !pDriver && m_flSpeed == 0 && m_bGrounded && m_flFall == 0;
	pev->nextthink = gpGlobals->time + (resting ? 0.1f : 0.01f);
}

// One frame of the car: from its think, and from its driver's PostThink (a frame's second call finds dt 0).
void CH9Car::Step(const char* by)
{
	float dt = gpGlobals->time - m_flLastThink; // the server's clock only: Step runs from the think alone
	m_flLastThink = gpGlobals->time;
	dt = H9Clamp(dt, 0, 0.1f);
	m_flLastDt = dt;

	CBasePlayer* pDriver = Driver();
	if (m_hDriver && (!pDriver || !pDriver->IsAlive() || pDriver->m_pTank != this)) // left, died or was taken out
	{
		if (pDriver && pDriver->m_pTank == NULL && !(pDriver->pev->effects & EF_NODRAW))
			pDriver = NULL; // already let go by LeaveWheel
		else if (pDriver)
		{
			pDriver->m_pTank = NULL;
			LeaveWheel(pDriver);
			pDriver = NULL;
		}
		m_hDriver = NULL;
		STOP_SOUND(edict(), CHAN_STATIC, STRING(m_iszEngine));
		m_bEngineOn = false;
	}

	if (pDriver) // +use gets him out: a fresh press (kept by the PostThink call), not the one that got him in
	{
		const bool pressed = m_bUsePressed;
		m_bUsePressed = false;
		if (pressed && gpGlobals->time > m_flEntered + 0.3f)
		{
			pDriver->m_pTank = NULL;
			LeaveWheel(pDriver);
			pDriver = NULL;
		}
	}

	if (dt > 0)
	{
		Steer(pDriver, dt);
		const bool hit = Move(dt);
		// R held a second: back to the last place it stood on four wheels touching nothing, level and at rest
		// (Diffusion's reset); it keeps that place's heading
		if (pDriver && (pDriver->pev->button & IN_RELOAD))
			m_flResetHeld += dt;
		else
			m_flResetHeld = 0;
		if (m_flResetHeld >= H9CAR_RESET_HOLD && m_bHasSafe)
		{
			m_flResetHeld = 0;
			UTIL_SetOrigin(pev, m_vecSafe);
			m_flYaw = m_flSafeYaw;
			m_flSpeed = m_flSteer = m_flPitch = m_flRoll = m_flFall = 0;
			for (float& z : m_flWheelGround)
				z = m_vecSafe.z;
			m_flFrontGround = m_flRearGround = m_vecSafe.z;
			EMIT_SOUND_DYN(edict(), CHAN_ITEM, "plats/vehicle_ignition.wav", 0.8, ATTN_NORM, 0, PITCH_NORM);
		}
		else if (!hit && m_bAllWheels && m_flFall == 0)
		{
			// a place a second old, and safe the whole second since: not the spot just before it got stuck
			if (!m_bPending)
			{
				m_vecPending = pev->origin;
				m_flPendingYaw = m_flYaw;
				m_flPendingAt = gpGlobals->time;
				m_bPending = true;
			}
			else if (gpGlobals->time >= m_flPendingAt + 1.0f)
			{
				m_vecSafe = m_vecPending;
				m_flSafeYaw = m_flPendingYaw;
				m_bHasSafe = true;
				m_bPending = false;
			}
		}
		else
			m_bPending = false;
		Settle(dt);
		FitBox();
		SetBoneController(0, m_flSteer);
		SetBoneController(1, m_flSteer);
		// the roll: one cycle is one turn of the wheels, so the rate is turns a second times the cycle's length
		const float cycle = m_flFrameRate > 0 ? 256.0f / m_flFrameRate : 1.0f;
		pev->framerate = m_flSpeed / (2 * M_PI * (m_flRadius > 1 ? m_flRadius : 1)) * cycle;
		StudioFrameAdvance(dt);
		if (pev->frame < 0) // StudioFrameAdvance wraps a loop only forwards
			pev->frame += 256 * (1 + (int)(-pev->frame / 256));
	}

	if (pDriver)
	{
		pDriver->pev->weaponmodel = 0;
		pDriver->pev->viewmodel = 0;
		pDriver->pev->velocity = g_vecZero;
		pDriver->pev->solid = SOLID_NOT;
		pDriver->pev->owner = edict();
		UTIL_SetOrigin(pDriver->pev, pev->origin + Vector(0, 0, 40)); // he rides inside: the sounds and the PVS follow
		PlaceCamera(dt);
		Sound();
		if (CVAR_GET_FLOAT("developer") > 0 && gpGlobals->time >= m_flNextReport)
		{
			m_flNextReport = gpGlobals->time + 0.5f;
			// two lines: the engine cuts a console message at about 190 characters
			char line[160];
			snprintf(line, sizeof(line), "h9_car: buttons %x dt %.3f speed %.0f steer %.1f yaw %.0f grounded %d\n",
				pDriver->pev->button, m_flLastDt, m_flSpeed, m_flSteer, m_flYaw, m_bGrounded ? 1 : 0);
			ClientPrint(pDriver->pev, HUD_PRINTCONSOLE, line);
			snprintf(line, sizeof(line), "  stop %.1fs ago by %d on %s at %.2f; z %.1f pitch %.1f ground %.1f/%.1f\n",
				m_flLastHitTime < 0 ? -1.0f : gpGlobals->time - m_flLastHitTime, m_iLastHitBy, m_szLastHit, m_flLastHit,
				pev->origin.z, m_flPitch, m_flFrontGround, m_flRearGround);
			ClientPrint(pDriver->pev, HUD_PRINTCONSOLE, line);
		}
	}
}
