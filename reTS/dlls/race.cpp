/***
*  race.cpp -- the race mode (H9; h9-maps maps/race01/FINAL.md, contract 1 and task C1).
*
*  A map turns the mode on by having one race_rules entity. That entity owns the whole race: every server frame
*  its think looks where each racer is (his h9_car's origin while he drives one, his own otherwise), tests the
*  move he made since the frame before against every race_checkpoint's box, and gives what it finds to a
*  RaceBook (race_book.h), which counts checkpoints in order, laps, times and places. Nothing here waits for a
*  Touch: a driver is SOLID_NOT and his car sets its own origin, so the engine's trigger touches do not come.
*
*  One clock only: the think's gpGlobals->time. Xash runs a player's PreThink and PostThink at the client's
*  timebase, so no time is ever taken there.
*
*  A race goes WAITING (until a player is in, then a warm-up of mp_racewarmup seconds), COUNTDOWN (`countdown`
*  seconds: the numbers, the gantry's lights, racers held), RACING, FINISHED (the first to finish gives the
*  others `finishwait` seconds; then the results show, and a new race is set up).
*
*  The entities (contract 1):
*    race_rules       point   laps 3, countdown 5, maxtime 0 (seconds a racer has from the green light; 0 = no
*                             limit), finishwait 30
*    race_checkpoint  brush   number (0 = the start and finish line, then 1..N in driving order), bonus (seconds
*                             added to the racer's `maxtime` when it counts)
*    race_grid        point   slot (1 = pole), angles
*    race_respawn     point   checkpoint (a car that has passed it is put back here), angles
*    race_waypoint    point   number, speed, spread (kept for the AI drivers of a later wave)
*    race_gantry      a targetname: every entity so named gets skin 0 (off), 1..4 (reds, over the countdown),
*                     5 (green, at the start; back to 0 three seconds later). Also a class: a studio model
*                     (key model, default models/h9/rc_gantry.mdl) that names itself race_gantry
*
*  The HUD is the client's for a game that has it (cl_dll/h9_racehud.cpp): such a game says so in its userinfo
*  (_h9race), and gets the H9R* user messages that race.h lists, sent from the think like everything else. Any
*  other game gets server text (TE_TEXTMESSAGE on four channels), sent a few times a second at most. RaceText is
*  the one door of the text: it lets nothing through to a player with the HUD.
*  Vehicle. race_rules `vehicle` is "car" (default: a racer is a player at the wheel of an h9_car on the grid) or "rally"
*  (a racer IS the car: a living player in rally mode, pm_shared/h9_rally.h). The cvar h9_rally 1..3 forces "rally" in any
*  map with race_rules. In rally mode everybody who joins is a racer on the lowest free grid slot (no lobby, no race_pick),
*  the map's h9_cars are not used, and a racer is held with FL_FROZEN (see RallyHold).
*  Cvars: mp_racelaps (0 = the map's `laps`), mp_racewarmup (seconds before each countdown, 10).
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "race.h"
#include "race_book.h"
#include "race_rally.h"
#include "h9_rally_srv.h"
#include "UserMessages.h"

#include <math.h>

#define RACE_CHANNEL_TABLE 0  // the results
#define RACE_CHANNEL_STATUS 1 // lap, place, times
#define RACE_CHANNEL_BIG 2    // countdown, GO, wrong way, finish
#define RACE_CHANNEL_NOTE 3   // a checkpoint's split, a lap's time

#define RACE_STATUS_EVERY 0.3f   // seconds between a player's status lines
#define RACE_WARN_EVERY 1.0f     // and between two "wrong way"
#define RACE_RESULTS_TIME 12.0f  // the results stay this long before the next race is set up
#define RACE_GREEN_TIME 3.0f     // the gantry stays green this long
#define RACE_JUMP 512.0f         // a move longer than this in one frame is a car put elsewhere, not a drive
#define RACE_BOX_MARGIN 8.0f     // a checkpoint's box is taken this much larger (a car's origin is on the floor)
#define RACE_MAX_PLAYERS 32

static cvar_t mp_racelaps = {"mp_racelaps", "0", FCVAR_SERVER};
static cvar_t mp_racewarmup = {"mp_racewarmup", "10", FCVAR_SERVER};
// HL Rally's mp_joinmidrace (dlls/game.cpp:460, FCVAR_ARCHIVE, default 1): a player who picks a car while a race runs joins it from lap 0
// (0: he waits for the next race). Needed because the changecar rule branches on it.
static cvar_t mp_joinmidrace = {"mp_joinmidrace", "1", FCVAR_ARCHIVE};

// Out of the race until the next one is set up (HL Rally's `pev->iuser3 = numlaps` after selectcar), by player index.
static bool s_sitOut[33];

void RaceRegisterCvars()
{
	CVAR_REGISTER(&mp_racelaps);
	CVAR_REGISTER(&mp_racewarmup);
	CVAR_REGISTER(&mp_joinmidrace);
}

//=========================================================
// The map's entities besides the rules: they only keep their keys.
//=========================================================
class CRaceCheckpoint : public CBaseEntity
{
public:
	void Spawn() override
	{
		pev->solid = SOLID_NOT; // nothing touches it: race_rules tests positions against its box
		pev->movetype = MOVETYPE_NONE;
		SET_MODEL(edict(), STRING(pev->model)); // the brush model gives the box
		pev->effects |= EF_NODRAW;
	}
	bool KeyValue(KeyValueData* pkvd) override
	{
		if (FStrEq(pkvd->szKeyName, "number"))
		{
			m_iNumber = atoi(pkvd->szValue);
			return true;
		}
		if (FStrEq(pkvd->szKeyName, "bonus"))
		{
			m_flBonus = atof(pkvd->szValue);
			return true;
		}
		return CBaseEntity::KeyValue(pkvd);
	}
	int ObjectCaps() override { return CBaseEntity::ObjectCaps() & ~FCAP_ACROSS_TRANSITION; }

	int m_iNumber = 0;
	float m_flBonus = 0;
};
LINK_ENTITY_TO_CLASS(race_checkpoint, CRaceCheckpoint);

class CRaceGrid : public CPointEntity
{
public:
	bool KeyValue(KeyValueData* pkvd) override
	{
		if (FStrEq(pkvd->szKeyName, "slot"))
		{
			m_iSlot = atoi(pkvd->szValue);
			return true;
		}
		return CPointEntity::KeyValue(pkvd);
	}
	int m_iSlot = 0;
};
LINK_ENTITY_TO_CLASS(race_grid, CRaceGrid);

class CRaceRespawn : public CPointEntity
{
public:
	bool KeyValue(KeyValueData* pkvd) override
	{
		if (FStrEq(pkvd->szKeyName, "checkpoint"))
		{
			m_iCheckpoint = atoi(pkvd->szValue);
			return true;
		}
		return CPointEntity::KeyValue(pkvd);
	}
	int m_iCheckpoint = 0;
};
LINK_ENTITY_TO_CLASS(race_respawn, CRaceRespawn);

class CRaceWaypoint : public CPointEntity
{
public:
	bool KeyValue(KeyValueData* pkvd) override
	{
		if (FStrEq(pkvd->szKeyName, "number"))
		{
			m_iNumber = atoi(pkvd->szValue);
			return true;
		}
		if (FStrEq(pkvd->szKeyName, "speed"))
		{
			m_flSpeed = atof(pkvd->szValue);
			return true;
		}
		if (FStrEq(pkvd->szKeyName, "spread"))
		{
			m_flSpread = atof(pkvd->szValue);
			return true;
		}
		return CPointEntity::KeyValue(pkvd);
	}
	int m_iNumber = 0;
	float m_flSpeed = 0, m_flSpread = 0;
};
LINK_ENTITY_TO_CLASS(race_waypoint, CRaceWaypoint);

// A model with the gantry's name, for a map that has no other entity to show it with. Not solid: the map
// stands clip brushes where its legs are.
class CRaceGantry : public CBaseAnimating
{
public:
	void Spawn() override
	{
		if (FStringNull(pev->model))
			pev->model = MAKE_STRING("models/h9/rc_gantry.mdl");
		// a precache of a file that is not there stops the map
		int length = 0;
		byte* file = LOAD_FILE_FOR_ME((char*)STRING(pev->model), &length);
		if (!file)
		{
			ALERT(at_error, "race_gantry: its model %s is not on disk; removed\n", STRING(pev->model));
			UTIL_Remove(this);
			return;
		}
		FREE_FILE(file);
		PRECACHE_MODEL((char*)STRING(pev->model));
		SET_MODEL(edict(), STRING(pev->model));
		pev->solid = SOLID_NOT;
		pev->movetype = MOVETYPE_NONE;
		pev->skin = 0;
		if (FStringNull(pev->targetname))
			pev->targetname = MAKE_STRING("race_gantry");
	}
	int ObjectCaps() override { return CBaseAnimating::ObjectCaps() & ~FCAP_ACROSS_TRANSITION; }
};
LINK_ENTITY_TO_CLASS(race_gantry, CRaceGantry);

//=========================================================
// The rules: the one entity that runs the race.
//=========================================================
class CRaceRules : public CPointEntity
{
public:
	~CRaceRules() override;
	void Spawn() override;
	void Precache() override;
	bool KeyValue(KeyValueData* pkvd) override;
	int ObjectCaps() override { return (CPointEntity::ObjectCaps() & ~FCAP_ACROSS_TRANSITION) | FCAP_DONT_SAVE; }
	void EXPORT RaceThink();

	bool Valid() const { return m_bSurveyed && m_bValid; }
	RaceState State() const { return m_state; }
	int Round() const { return m_iRound; }
	bool Holds(CBasePlayer* pPlayer);
	bool FinishedCar(CBasePlayer* pPlayer);
	bool Running() const { return m_book.Running() && m_flResultsEnd == 0; } // HL Rally's m_RoundState == 1
	bool Done(CBasePlayer* pPlayer) const;
	void PutOnSlot(CBasePlayer* pPlayer);
	int SlotOf(CBasePlayer* pPlayer);
	bool RespawnPoint(CBasePlayer* pPlayer, Vector& origin, Vector& angles);
	void Placed(CBasePlayer* pPlayer);

private:
	struct Checkpoint
	{
		bool present = false;
		Vector mins, maxs, centre;
		float bonus = 0;
		float along = 0; // where it is on the lap's line (the waypoints), units from waypoint 0
	};
	// The lap's line: the race_waypoints in order, and how far along it each one is. With it a racer's distance to
	// his next checkpoint is measured along the road, not straight across a hairpin.
	struct Mark
	{
		Vector at;
		float along = 0;
	};
	enum { RACE_MAX_MARKS = 512 };
	Mark m_marks[RACE_MAX_MARKS];
	int m_iMarks = 0;
	float m_flLine = 0; // the whole lap's length along it
	float Along(const Vector& at) const;
	float ToCheckpoint(const Vector& at, int number) const;
	// A player the race knows: his grid slot and what it saw of him the frame before.
	struct Seat
	{
		bool in = false;
		int slot = 0;
		Vector last;
		bool hasLast = false;
		unsigned long long inside = 0; // the checkpoints his last move met, one bit each
		float nextStatus = 0, nextWarn = 0;
		// rally mode
		bool frozen = false;       // FL_FROZEN is set by the race
		RacePutKey putKey;         // the put-back key (HL Rally's `k`): at once, then a second's rest
		float nextLook = 0;        // when the surface under him is read again
		int surface = 0;           // and what it was (the low 3 bits of blending[1])
	};

	void Survey();
	void Roster();
	int Racers() const;
	void SetState(RaceState state);
	void NewRace();
	void Wait();
	void Countdown();
	void Go();
	void Race(float dt);
	void Results();
	void Track(int index, CBasePlayer* pPlayer, float dt);
	void Tell(int index, CBasePlayer* pPlayer, RaceEvent event, int checkpoint);
	void Status(int index, CBasePlayer* pPlayer);
	void Gantry(int skin);
	void Beep(const char* sample, int pitch);

public:
	bool Rally() const { return RaceRallyClass() > 0; }
	// the countdown's length: in rally mode HL Rally's own (dlls/rally_rounds.h: COUNTDOWN_TIME 3.6), whatever the map says
	float CountdownLen() const { return Rally() ? 3.6f : m_flCountdown; }
	bool RallyKey() const { return m_bRallyKey; }
	bool HudOn(int index) const { return index >= 1 && index <= RACE_MAX_PLAYERS && m_hud[index].on; }

private:
	// What a player's game has been sent of the HUD (race.h). All of it goes back to nothing when he leaves, when
	// another player takes his place, and when his game stops saying it has the HUD.
	struct Hud
	{
		int userid = -1;       // who this is about
		bool on = false;       // his game has the HUD, and is in the map
		float nextAsk = 0;     // when his userinfo is read again
		int lineStage = 0;     // the lap's line: 0 its points, 1 the checkpoints, 2 all sent
		int lineSent = 0;      // how many of that stage have gone
		int stateSerial = -1;  // the H9RState he has
		int resultsSerial = 0; // the results he has
		float nextStatus = 0, nextPos = 0;
	};
	// What H9RState says; when any of it changes, everybody is told.
	struct HudState
	{
		int state = -1, laps = 0, racers = 0;
		bool results = false;
		float t0 = 0;
	};
	void HudFrame();
	bool HudLinePart(CBasePlayer* pPlayer, Hud& hud);
	void HudSendState(CBasePlayer* pPlayer);
	void HudSendStatus(int index, CBasePlayer* pPlayer);
	void HudSendPositions(CBasePlayer* pPlayer);
	void HudSendResults(CBasePlayer* pPlayer);
	void HudNote(int index, CBasePlayer* pPlayer, int kind, int a, int b, int flags, float time, float diff);
	float HudProgress(const RaceRacer& racer) const;

	Hud m_hud[RACE_MAX_PLAYERS + 1]; // by player index
	HudState m_hudState;
	int m_iHudSerial = 0;     // counts the changes of m_hudState
	int m_iResultsSerial = 0; // counts the results shown

	// settings (keys)
	int m_iLaps = 3;
	float m_flCountdown = 5, m_flMaxTime = 0, m_flFinishWait = 30;
	bool m_bRallyKey = false;                 // "vehicle" "rally"
	bool m_bAutoJoin = false;                 // "autojoin": no lobby; whoever is on foot is put in a free grid car
	float m_flSeatAt[RACE_MAX_PLAYERS + 1] = {}; // by player index: not before this (he has just left a car)
	bool m_bHadCar[RACE_MAX_PLAYERS + 1] = {};
	void AutoJoin();

	// rally mode
	bool m_bWasRally = false;   // the mode the seats were made for
	int m_iGrid = 0;            // grid slots the map has (1..m_iGrid, no gaps)
	float m_flRallyDt = 0;
	void RallyRoster();
	void RallyFrame(float dt);
	void RallyPut(CBasePlayer* pPlayer, const Vector& origin, const Vector& angles);
	void RallyHold(int index, CBasePlayer* pPlayer, bool held);
	void RallyRelease(CBasePlayer* pPlayer);
	void RallySeats();
	void DriveState(CBasePlayer* pPlayer, float& speed, float& slip, float& top) const;

	// the map
	Checkpoint m_checkpoints[RACE_MAX_CHECKPOINTS];
	int m_iCheckpoints = 0;
	bool m_bSurveyed = false, m_bValid = false;

	// the race
	RaceBook m_book;
	Seat m_seats[RACE_MAX_PLAYERS + 1]; // by player index
	RaceState m_state = RACE_WAITING;
	int m_iRound = 0;
	float m_flLastThink = 0;
	float m_flWarmEnd = 0;    // WAITING: when the countdown begins; 0 while nobody is in
	float m_flGo = 0;         // COUNTDOWN: the green light
	float m_flFinishEnd = 0;  // FINISHED: when the others' time is up
	float m_flResultsEnd = 0; // FINISHED: when the table goes; 0 until it shows
	float m_flGantryOff = 0;
	int m_iShown = -1;        // the last number shown (warm-up or countdown)
	int m_iGantry = -1;
};
LINK_ENTITY_TO_CLASS(race_rules, CRaceRules);

static CRaceRules* g_pRace = NULL; // the map's race_rules; the entity clears it when it goes

// ── text ──

// m:ss.cc, or m:ss.t with `tenths` (a line sent four times a second cannot show hundredths honestly).
static const char* RaceTime(float seconds, bool tenths = false)
{
	static char buffers[4][24];
	static int turn = 0;
	char* text = buffers[turn = (turn + 1) % 4];
	if (seconds < 0)
		seconds = 0;
	const int minutes = (int)(seconds / 60);
	const float rest = seconds - minutes * 60;
	if (tenths)
		snprintf(text, 24, "%d:%04.1f", minutes, floorf(rest * 10) / 10);
	else
		snprintf(text, 24, "%d:%05.2f", minutes, floorf(rest * 100) / 100);
	return text;
}

static const char* RaceOrdinal(int place)
{
	static char text[16];
	const char* end = "th";
	if (place % 100 < 11 || place % 100 > 13)
		end = place % 10 == 1 ? "st" : (place % 10 == 2 ? "nd" : (place % 10 == 3 ? "rd" : "th"));
	snprintf(text, sizeof(text), "%d%s", place, end);
	return text;
}

static void RaceText(CBaseEntity* pPlayer, int channel, float x, float y, int r, int g, int b, float hold, const char* text)
{
	hudtextparms_t parms;
	memset(&parms, 0, sizeof(parms));
	parms.x = x;
	parms.y = y;
	parms.effect = 0;
	parms.r1 = r, parms.g1 = g, parms.b1 = b, parms.a1 = 255;
	parms.r2 = r, parms.g2 = g, parms.b2 = b, parms.a2 = 255;
	parms.fadeinTime = 0;
	parms.fadeoutTime = 0.15f;
	parms.holdTime = hold;
	parms.channel = channel;
	// a player whose game draws the race HUD gets none of the text
	if (pPlayer)
	{
		if (!g_pRace || !g_pRace->HudOn(pPlayer->entindex()))
			UTIL_HudMessage(pPlayer, parms, text);
		return;
	}
	for (int index = 1; index <= gpGlobals->maxClients; index++)
	{
		CBaseEntity* pEach = UTIL_PlayerByIndex(index);
		if (pEach && (!g_pRace || !g_pRace->HudOn(index)))
			UTIL_HudMessage(pEach, parms, text);
	}
}

static void RaceBig(CBaseEntity* pPlayer, int r, int g, int b, float hold, const char* text)
{
	RaceText(pPlayer, RACE_CHANNEL_BIG, -1, 0.22f, r, g, b, hold, text);
}

static void RaceNote(CBaseEntity* pPlayer, int r, int g, int b, const char* text)
{
	RaceText(pPlayer, RACE_CHANNEL_NOTE, -1, 0.33f, r, g, b, 3.0f, text);
}

// ── who and where ──

// The connected player with this index, or NULL. A client's edict is never freed, so the engine is asked
// whether somebody is on it.
static CBasePlayer* RacePlayer(int index)
{
	CBaseEntity* pEntity = UTIL_PlayerByIndex(index);
	if (!pEntity || !pEntity->IsPlayer() || GETPLAYERUSERID(pEntity->edict()) == -1)
		return NULL;
	if (FStringNull(pEntity->pev->netname) || !STRING(pEntity->pev->netname)[0])
		return NULL;
	return static_cast<CBasePlayer*>(pEntity);
}

// Where the racer is: his car while he drives one (he is held inside it), himself otherwise.
static Vector RacePosition(CBasePlayer* pPlayer)
{
	CBaseEntity* pTank = pPlayer->m_pTank;
	if (pTank && FClassnameIs(pTank->pev, "h9_car"))
		return pTank->pev->origin;
	return pPlayer->pev->origin;
}

// ── the entity ──

CRaceRules::~CRaceRules()
{
	if (g_pRace == this)
		g_pRace = NULL;
}

bool CRaceRules::KeyValue(KeyValueData* pkvd)
{
	if (FStrEq(pkvd->szKeyName, "laps"))
		m_iLaps = atoi(pkvd->szValue);
	else if (FStrEq(pkvd->szKeyName, "countdown"))
		m_flCountdown = atof(pkvd->szValue);
	else if (FStrEq(pkvd->szKeyName, "maxtime"))
		m_flMaxTime = atof(pkvd->szValue);
	else if (FStrEq(pkvd->szKeyName, "finishwait"))
		m_flFinishWait = atof(pkvd->szValue);
	else if (FStrEq(pkvd->szKeyName, "vehicle"))
		m_bRallyKey = RaceVehicleKeyIsRally(pkvd->szValue);
	else if (FStrEq(pkvd->szKeyName, "autojoin"))
		m_bAutoJoin = atoi(pkvd->szValue) != 0;
	else
		return CPointEntity::KeyValue(pkvd);
	return true;
}

void CRaceRules::Precache()
{
	PRECACHE_SOUND("buttons/blip1.wav"); // a countdown second
	PRECACHE_SOUND("buttons/bell1.wav"); // the green light, a finish
}

void CRaceRules::Spawn()
{
	if (g_pRace && g_pRace != this)
	{
		ALERT(at_error, "race_rules: the map has more than one; this one is removed\n");
		UTIL_Remove(this);
		return;
	}
	Precache();
	CPointEntity::Spawn();
	g_pRace = this;
	if (m_iLaps < 1)
		m_iLaps = 1;
	if (m_flCountdown < 0)
		m_flCountdown = 0;
	if (m_flFinishWait < 0)
		m_flFinishWait = 0;
	m_flLastThink = gpGlobals->time;
	SetThink(&CRaceRules::RaceThink);
	pev->nextthink = gpGlobals->time + 0.5f; // the other entities have spawned by then
}

// The checkpoints of the map, once: they must be numbered 0..N with none missing and none twice.
void CRaceRules::Survey()
{
	m_bSurveyed = true;
	m_bValid = true;
	m_iCheckpoints = 0;
	int highest = -1;
	CBaseEntity* pEntity = NULL;
	while ((pEntity = UTIL_FindEntityByClassname(pEntity, "race_checkpoint")) != NULL)
	{
		CRaceCheckpoint* pCheckpoint = static_cast<CRaceCheckpoint*>(pEntity);
		const int number = pCheckpoint->m_iNumber;
		if (number < 0 || number >= RACE_MAX_CHECKPOINTS)
		{
			ALERT(at_error, "race_checkpoint: number %d is outside 0..%d\n", number, RACE_MAX_CHECKPOINTS - 1);
			m_bValid = false;
			continue;
		}
		Checkpoint& checkpoint = m_checkpoints[number];
		if (checkpoint.present)
		{
			ALERT(at_error, "race_checkpoint: number %d is given to two checkpoints\n", number);
			m_bValid = false;
			continue;
		}
		const Vector margin(RACE_BOX_MARGIN, RACE_BOX_MARGIN, RACE_BOX_MARGIN);
		checkpoint.present = true;
		checkpoint.mins = pCheckpoint->pev->origin + pCheckpoint->pev->mins - margin;
		checkpoint.maxs = pCheckpoint->pev->origin + pCheckpoint->pev->maxs + margin;
		checkpoint.centre = (checkpoint.mins + checkpoint.maxs) * 0.5f;
		checkpoint.bonus = pCheckpoint->m_flBonus;
		if (number > highest)
			highest = number;
	}
	m_iCheckpoints = highest + 1;
	if (m_iCheckpoints < 1)
	{
		ALERT(at_error, "race_rules: the map has no race_checkpoint (number 0 is the start and finish line)\n");
		m_bValid = false;
	}
	for (int number = 0; number < m_iCheckpoints; number++)
	{
		if (!m_checkpoints[number].present)
		{
			ALERT(at_error, "race_rules: race_checkpoint number %d is missing (the highest is %d)\n", number, highest);
			m_bValid = false;
		}
	}
	if (!m_bValid)
	{
		ALERT(at_error, "race_rules: no race in this map until its checkpoints are right\n");
		return;
	}
	Vector origin, angles;
	if (!RaceGridSlot(1, origin, angles))
		ALERT(at_warning, "race_rules: the map has no race_grid with slot 1\n");
	// the lap's line
	m_iMarks = 0;
	m_flLine = 0;
	float speed, spread;
	while (m_iMarks < RACE_MAX_MARKS && RaceWaypoint(m_iMarks, m_marks[m_iMarks].at, speed, spread))
		m_iMarks++;
	if (m_iMarks >= 3)
	{
		for (int i = 0; i < m_iMarks; i++)
		{
			m_marks[i].along = m_flLine;
			m_flLine += (m_marks[(i + 1) % m_iMarks].at - m_marks[i].at).Length2D();
		}
		for (int number = 0; number < m_iCheckpoints; number++)
			m_checkpoints[number].along = Along(m_checkpoints[number].centre);
	}
	else
	{
		m_iMarks = 0;
		ALERT(at_warning, "race_rules: no race_waypoint line (numbers 0, 1, 2...): places and the wrong-way watch go by straight distance\n");
	}
	// the grid, and the lowest place any race entity stands on (a racer below that much less 2000 is out of the world)
	m_iGrid = 0;
	{
		Vector o, a;
		while (m_iGrid < RACE_MAX_PLAYERS && RaceGridSlot(m_iGrid + 1, o, a))
			m_iGrid++;
	}
	if (Rally())
	{
		// the map's grid cars are not used: seen by nobody, touched by nobody, entered by nobody (race_rally guards in
		// h9_car.cpp: Use, RaceSeatFree, race_pick)
		CBaseEntity* pCar = NULL;
		int hidden = 0;
		while ((pCar = UTIL_FindEntityByClassname(pCar, "h9_car")) != NULL)
			if (pCar->pev->iuser4 > 0)
			{
				pCar->pev->effects |= EF_NODRAW;
				pCar->pev->solid = SOLID_NOT;
				hidden++;
			}
		ALERT(at_console, "race_rules: rally mode (class %d): racers are players; %d grid h9_cars are not used, %d grid places\n",
			RaceRallyClass(), hidden, m_iGrid);
		if (m_iGrid == 0)
			ALERT(at_error, "race_rules: rally mode and the map has no race_grid: nobody can race\n");
	}
	// what a player needs to get into the race at all
	int cars = 0, picks = 0;
	CBaseEntity* pThing = NULL;
	while ((pThing = UTIL_FindEntityByClassname(pThing, "h9_car")) != NULL)
		if (pThing->pev->iuser4 > 0)
			cars++;
	pThing = NULL;
	while ((pThing = UTIL_FindEntityByClassname(pThing, "race_pick")) != NULL)
		picks++;
	if (cars == 0 && !Rally())
		ALERT(at_warning, "race_rules: the map has no h9_car with a slot key: nobody can race\n");
	if (picks == 0 && !m_bAutoJoin && !Rally())
		ALERT(at_warning, "race_rules: the map has no race_pick: nobody can get into a grid car\n");
	ALERT(at_console, "race_rules: %d checkpoints, %d laps, countdown %.0f s, finishwait %.0f s, maxtime %.0f s\n",
		m_iCheckpoints, m_iLaps, m_flCountdown, m_flFinishWait, m_flMaxTime);
}

// Who is on the server: a newcomer gets the lowest grid slot free and joins the book; one who left gives his
// slot back.
void CRaceRules::Roster()
{
	if (Rally())
	{
		RallyRoster();
		return;
	}
	for (int index = 1; index <= gpGlobals->maxClients && index <= RACE_MAX_PLAYERS; index++)
	{
		Seat& seat = m_seats[index];
		CBasePlayer* pPlayer = RacePlayer(index);
		// a racer is a player at the wheel of a grid car (he chose it in the lobby: race_pick); on foot he is nobody
		CBaseEntity* pCar = pPlayer ? (CBaseEntity*)pPlayer->m_pTank : NULL;
		if (!pCar || !FClassnameIs(pCar->pev, "h9_car") || pCar->pev->iuser4 <= 0)
			pPlayer = NULL;
		if (!pPlayer)
		{
			if (seat.in)
			{
				m_book.Remove(index);
				seat = Seat();
			}
			continue;
		}
		if (seat.in)
			continue;
		const int slot = pCar->pev->iuser4; // his car's grid slot
		seat = Seat();
		seat.in = true;
		seat.slot = slot;
		m_book.Add(index);
		if (m_state == RACE_WAITING)
			m_flWarmEnd = 0; // the warm-up begins again: those still choosing a buggy start with him
		ALERT(at_console, "race: %s takes grid slot %d\n", STRING(pPlayer->pev->netname), slot);
	}
}

// How far along the lap's line a place is: the nearest waypoint, and the place set down on the stretch after it
// (or before it).
float CRaceRules::Along(const Vector& at) const
{
	int nearest = 0;
	float best = -1;
	for (int i = 0; i < m_iMarks; i++)
	{
		const float d = (m_marks[i].at - at).Length2D();
		if (best < 0 || d < best)
		{
			best = d;
			nearest = i;
		}
	}
	const Mark& here = m_marks[nearest];
	const Mark& next = m_marks[(nearest + 1) % m_iMarks];
	const Mark& last = m_marks[(nearest + m_iMarks - 1) % m_iMarks];
	Vector ahead = next.at - here.at, behind = here.at - last.at;
	ahead.z = behind.z = 0;
	const float aheadLength = ahead.Length(), behindLength = behind.Length();
	Vector to = at - here.at;
	to.z = 0;
	float step = 0;
	const float forward = aheadLength > 0 ? DotProduct(to, ahead) / aheadLength : 0;
	const float backward = behindLength > 0 ? DotProduct(to, behind) / behindLength : 0;
	if (forward > 0)
		step = forward < aheadLength ? forward : aheadLength;
	else if (backward < 0)
		step = backward > -behindLength ? backward : -behindLength;
	float along = here.along + step;
	if (along < 0)
		along += m_flLine;
	if (along >= m_flLine)
		along -= m_flLine;
	return along;
}

// A racer's way to go to a checkpoint: along the lap's line where the map has one, else straight.
float CRaceRules::ToCheckpoint(const Vector& at, int number) const
{
	if (m_iMarks == 0 || m_flLine <= 0)
		return (m_checkpoints[number].centre - at).Length();
	float left = m_checkpoints[number].along - Along(at);
	if (left < 0)
		left += m_flLine;
	if (left > m_flLine - 600) // he is at it, a little past its middle and not yet counted
		left = 0;
	return left;
}

int CRaceRules::Racers() const
{
	return m_book.Count();
}

void CRaceRules::SetState(RaceState state)
{
	static const char* names[] = {"WAITING", "COUNTDOWN", "RACING", "FINISHED"};
	m_state = state;
	m_iShown = -1;
	ALERT(at_console, "race: %s (round %d, %d racers)\n", names[state], m_iRound, Racers());
}

void CRaceRules::Gantry(int skin)
{
	if (skin == m_iGantry)
		return;
	m_iGantry = skin;
	CBaseEntity* pEntity = NULL;
	while ((pEntity = UTIL_FindEntityByTargetname(pEntity, "race_gantry")) != NULL)
		pEntity->pev->skin = skin;
}

void CRaceRules::Beep(const char* sample, int pitch)
{
	UTIL_EmitAmbientSound(edict(), pev->origin, sample, 0.8f, ATTN_NONE, 0, pitch);
}

// A new race is set up: back to waiting; the warm-up is free driving, and the countdown calls the cars to the grid.
void CRaceRules::NewRace()
{
	// the next race: the players who sat this one out are let in (HL Rally's round restart brings back everybody with fuser1 set;
	// one who has not chosen a car again stays an observer, and a car he picks now is applied at once)
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		if (!s_sitOut[index])
			continue;
		s_sitOut[index] = false;
		CBasePlayer* pPlayer = RacePlayer(index);
		if (Rally() && pPlayer && pPlayer->IsObserver() && H9RallyChosen(index))
			H9RallyLeaveObserver(pPlayer);
	}
	m_book.Stop();
	m_flWarmEnd = 0;
	m_flResultsEnd = 0;
	Gantry(0);
	SetState(RACE_WAITING);
}

void CRaceRules::RaceThink()
{
	const float now = gpGlobals->time;
	float dt = now - m_flLastThink;
	m_flLastThink = now;
	dt = dt < 0 ? 0 : (dt > 0.25f ? 0.25f : dt);
	pev->nextthink = now + 0.01f; // every frame

	if (!m_bSurveyed)
		Survey();
	if (!m_bValid)
	{
		pev->nextthink = now + 5.0f;
		return;
	}
	if (Rally() != m_bWasRally)
		RallySeats(); // the vehicle changed (the cvar): the seats of the other kind are given up
	if (m_bAutoJoin && !Rally())
		AutoJoin();
	Roster();
	if (Rally())
		RallyFrame(dt);
	HudFrame();
	if (m_flGantryOff > 0 && now >= m_flGantryOff)
	{
		m_flGantryOff = 0;
		Gantry(0);
	}

	if ((m_state == RACE_RACING || m_state == RACE_FINISHED) && Racers() == 0 && m_flResultsEnd == 0)
	{
		NewRace(); // everybody got out
		return;
	}
	switch (m_state)
	{
	case RACE_WAITING: Wait(); break;
	case RACE_COUNTDOWN: Countdown(); break;
	case RACE_RACING:
	case RACE_FINISHED: Race(dt); break;
	}
}

// "autojoin": a map with no lobby (the way HL Rally's are). A player on foot is put in a free grid car: when he
// comes in, in the middle of a race too, and three seconds after he left one (he got out, or the results are over).
// Not while a race is ending: he would be held and then put out with the rest.
void CRaceRules::AutoJoin()
{
	for (int index = 1; index <= gpGlobals->maxClients && index <= RACE_MAX_PLAYERS; index++)
	{
		CBasePlayer* pPlayer = RacePlayer(index);
		const bool has = pPlayer && pPlayer->m_pTank != NULL;
		if (m_bHadCar[index] && !has)
			m_flSeatAt[index] = gpGlobals->time + 3.0f;
		m_bHadCar[index] = has;
		if (!pPlayer || has || !pPlayer->IsAlive() || m_state == RACE_FINISHED || gpGlobals->time < m_flSeatAt[index])
			continue;
		if (RaceSeatFree(pPlayer))
			m_bHadCar[index] = true;
		else
			m_flSeatAt[index] = gpGlobals->time + 1.0f; // the grid is full: look again in a second
	}
}

// Nobody in: nothing. Somebody in: the warm-up, then the countdown.
void CRaceRules::Wait()
{
	const float now = gpGlobals->time;
	// where everybody is, so that the first frame of the race has a move to test
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		CBasePlayer* pPlayer = m_seats[index].in ? RacePlayer(index) : NULL;
		if (pPlayer)
			Track(index, pPlayer, 0);
	}
	if (Racers() == 0)
	{
		m_flWarmEnd = 0;
		return;
	}
	if (m_flWarmEnd == 0)
	{
		float warm = mp_racewarmup.value;
		m_flWarmEnd = now + (warm < 0 ? 0 : warm);
		m_iShown = -1;
	}
	const int left = (int)ceilf(m_flWarmEnd - now);
	if (left > 0)
	{
		if (left != m_iShown)
		{
			m_iShown = left;
			char text[64];
			snprintf(text, sizeof(text), "RACE STARTS IN %d", left);
			RaceText(NULL, RACE_CHANNEL_STATUS, 0.02f, 0.30f, 255, 200, 60, 1.3f, text);
		}
		return;
	}
	// the laps are fixed here for the whole race
	const int laps = mp_racelaps.value >= 1 ? (int)mp_racelaps.value : m_iLaps;
	m_book.Configure(m_iCheckpoints, laps);
	m_flGo = now + CountdownLen();
	m_iRound++; // the cars go to the grid (the car reads RaceRound)
	if (Rally())
	{
		// the racers are players: the same moment puts each on his slot
		for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
		{
			CBasePlayer* pPlayer = m_seats[index].in ? RacePlayer(index) : NULL;
			Vector origin, angles;
			if (pPlayer && RaceGridSlot(m_seats[index].slot, origin, angles))
			{
				RallyPut(pPlayer, origin, angles);
				Placed(pPlayer);
			}
		}
	}
	SetState(RACE_COUNTDOWN);
	Countdown();
}

// The numbers and the reds; nothing is counted yet.
void CRaceRules::Countdown()
{
	const float now = gpGlobals->time;
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		CBasePlayer* pPlayer = m_seats[index].in ? RacePlayer(index) : NULL;
		if (pPlayer)
			Track(index, pPlayer, 0);
	}
	if (Racers() == 0) // everybody left
	{
		NewRace();
		return;
	}
	const float left = m_flGo - now;
	if (left <= 0)
	{
		Go();
		return;
	}
	// four reds, one after another over the countdown
	int reds = 1 + (int)((CountdownLen() - left) / CountdownLen() * 4);
	Gantry(reds < 1 ? 1 : (reds > 4 ? 4 : reds));
	const int number = (int)ceilf(left);
	if (number != m_iShown)
	{
		m_iShown = number;
		char text[16];
		snprintf(text, sizeof(text), "%d", number);
		RaceBig(NULL, 255, 60, 40, 1.1f, text);
		if (!Rally()) // a rally race has HL Rally's voice instead (cl_dll/h9_rallysnd.cpp)
			Beep("buttons/blip1.wav", 100);
	}
}

void CRaceRules::Go()
{
	m_book.Start(gpGlobals->time);
	for (Seat& seat : m_seats)
		seat.nextStatus = seat.nextWarn = 0;
	Gantry(5);
	m_flGantryOff = gpGlobals->time + RACE_GREEN_TIME;
	m_flFinishEnd = m_flResultsEnd = 0;
	RaceBig(NULL, 60, 255, 80, 1.5f, "GO!");
	if (!Rally())
		Beep("buttons/bell1.wav", 110);
	SetState(RACE_RACING);
}

// One racer's frame: the move he made against every checkpoint, and how far he is from his next one.
void CRaceRules::Track(int index, CBasePlayer* pPlayer, float dt)
{
	Seat& seat = m_seats[index];
	const Vector at = RacePosition(pPlayer);
	Vector from = seat.hasLast ? seat.last : at;
	if ((at - from).Length() > RACE_JUMP) // put elsewhere (grid, respawn): not a drive through what lies between
	{
		from = at;
		m_book.Placed(index);
	}
	seat.last = at;
	seat.hasLast = true;

	unsigned long long inside = 0;
	for (int number = 0; number < m_iCheckpoints; number++)
	{
		const Checkpoint& checkpoint = m_checkpoints[number];
		if (!RaceSegmentInBox(from, at, checkpoint.mins, checkpoint.maxs))
			continue;
		const unsigned long long bit = 1ULL << number;
		inside |= bit;
		if (seat.inside & bit) // he was in it already: only entering counts
			continue;
		const RaceEvent event = m_book.Enter(index, number, gpGlobals->time, checkpoint.bonus);
		if (event != RACE_EV_NONE)
			Tell(index, pPlayer, event, number);
	}
	seat.inside = inside;

	const RaceRacer* racer = m_book.Find(index);
	if (racer && m_book.Running() && !racer->finished && !racer->retired)
		m_book.Progress(index, ToCheckpoint(at, racer->next), dt);
}

// What a racer is told when a checkpoint answers.
void CRaceRules::Tell(int index, CBasePlayer* pPlayer, RaceEvent event, int checkpoint)
{
	const RaceRacer* racer = m_book.Find(index);
	if (!racer)
		return;
	char text[160];
	switch (event)
	{
	case RACE_EV_CHECKPOINT:
		if (racer->hasSplitDiff)
			snprintf(text, sizeof(text), "CHECKPOINT %d/%d   %s  (%+.2f)", checkpoint, m_iCheckpoints - 1, RaceTime(racer->split), racer->splitDiff);
		else
			snprintf(text, sizeof(text), "CHECKPOINT %d/%d   %s", checkpoint, m_iCheckpoints - 1, RaceTime(racer->split));
		RaceNote(pPlayer, 120, 220, 255, text);
		if (Rally())
			H9RallyMoneyCheckpoint(index); // HL Rally: +20 at a checkpoint that is not the line (rally_checkpoint.cpp:355)
		HudNote(index, pPlayer, RACE_NOTE_CHECKPOINT, checkpoint, m_iCheckpoints - 1, racer->hasSplitDiff ? RACE_NF_DIFF : 0,
			racer->split, racer->splitDiff);
		break;
	case RACE_EV_LAP:
		snprintf(text, sizeof(text), "LAP %d   %s%s", racer->lap, RaceTime(racer->lastLap), racer->lastLap <= racer->bestLap ? "   BEST LAP" : "");
		RaceNote(pPlayer, 255, 255, 120, text);
		// at the line the split is the lap, and its difference is against the best lap before this one
		HudNote(index, pPlayer, RACE_NOTE_LAP, racer->lap, m_book.Laps(),
			(racer->hasSplitDiff ? RACE_NF_DIFF : 0) | (racer->lastLap <= racer->bestLap ? RACE_NF_BEST : 0), racer->lastLap, racer->splitDiff);
		break;
	case RACE_EV_FINISH:
		snprintf(text, sizeof(text), "FINISH\n%s   %s", RaceOrdinal(racer->finishPlace), RaceTime(racer->total));
		RaceBig(pPlayer, 60, 255, 80, 5.0f, text);
		if (Rally())
			H9RallyMoneyFinish(index, racer->finishPlace); // HL Rally: the place's pay and 600 (rally_checkpoint.cpp:200-207)
		HudNote(index, pPlayer, RACE_NOTE_FINISH, racer->finishPlace, Racers(), 0, racer->total, racer->bestLap);
		snprintf(text, sizeof(text), "* %s finishes %s in %s (best lap %s)\n", STRING(pPlayer->pev->netname),
			RaceOrdinal(racer->finishPlace), RaceTime(racer->total), RaceTime(racer->bestLap));
		UTIL_ClientPrintAll(HUD_PRINTTALK, text);
		if (!Rally())
			Beep("buttons/bell1.wav", 100);
		break;
	case RACE_EV_WRONGWAY:
		m_seats[index].nextWarn = 0; // said at once, by Status
		break;
	default:
		break;
	}
	ALERT(at_aiconsole, "race: %s checkpoint %d event %d (lap %d, next %d)\n", STRING(pPlayer->pev->netname), checkpoint,
		(int)event, racer->lap, racer->next);
}

// A racer's lines: lap, place and times, a few times a second; "wrong way" once a second while it lasts.
void CRaceRules::Status(int index, CBasePlayer* pPlayer)
{
	Seat& seat = m_seats[index];
	const RaceRacer* racer = m_book.Find(index);
	const float now = gpGlobals->time;
	if (!racer || !pPlayer->IsNetClient() || HudOn(index)) // a game with the HUD is told by HudFrame
		return;
	if (now >= seat.nextStatus)
	{
		seat.nextStatus = now + RACE_STATUS_EVERY;
		char text[200];
		const int laps = m_book.Laps();
		if (racer->finished)
			snprintf(text, sizeof(text), "FINISHED %s of %d\nTIME %s\nBEST %s", RaceOrdinal(racer->finishPlace), Racers(),
				RaceTime(racer->total), RaceTime(racer->bestLap));
		else if (racer->retired)
			snprintf(text, sizeof(text), "OUT OF TIME\nLAP %d/%d", racer->lap + 1 > laps ? laps : racer->lap + 1, laps);
		else
		{
			char best[32] = "-:--.--";
			if (racer->bestLap > 0)
				snprintf(best, sizeof(best), "%s", RaceTime(racer->bestLap));
			char left[48] = "";
			if (m_flMaxTime > 0)
				snprintf(left, sizeof(left), "\nLEFT %s", RaceTime(m_book.StartTime() + m_flMaxTime + racer->bonus - now, true));
			float carSpeed, carSlip, carTop;
			DriveState(pPlayer, carSpeed, carSlip, carTop);
			const int speed = (int)fabsf(carSpeed);
			snprintf(text, sizeof(text), "LAP %d/%d   POS %d/%d\nTIME %s\nLAP  %s\nBEST %s%s\nSPEED %d", racer->lap + 1, laps,
				racer->place, Racers(), RaceTime(now - m_book.StartTime(), true), RaceTime(now - racer->lapStart, true), best,
				left, speed);
		}
		RaceText(pPlayer, RACE_CHANNEL_STATUS, 0.02f, 0.30f, 255, 200, 60, RACE_STATUS_EVERY * 3, text);
	}
	if (racer->wrongWay && now >= seat.nextWarn)
	{
		seat.nextWarn = now + RACE_WARN_EVERY;
		RaceBig(pPlayer, 255, 40, 40, RACE_WARN_EVERY + 0.2f, "WRONG WAY");
	}
}

// RACING and FINISHED: every racer's frame, the places, the time limits, and the end.
void CRaceRules::Race(float dt)
{
	const float now = gpGlobals->time;
	if (m_flResultsEnd > 0) // the table is up: nothing is counted
	{
		if (now >= m_flResultsEnd)
			NewRace();
		return;
	}
	if (Racers() == 0) // everybody left
	{
		NewRace();
		return;
	}
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		CBasePlayer* pPlayer = m_seats[index].in ? RacePlayer(index) : NULL;
		if (!pPlayer)
			continue;
		Track(index, pPlayer, dt);
		const RaceRacer* racer = m_book.Find(index);
		if (racer && m_flMaxTime > 0 && !racer->finished && !racer->retired && now - m_book.StartTime() > m_flMaxTime + racer->bonus)
		{
			m_book.Retire(index);
			RaceBig(pPlayer, 255, 40, 40, 4.0f, "OUT OF TIME");
			HudNote(index, pPlayer, RACE_NOTE_OUTOFTIME, racer->lap + 1 > m_book.Laps() ? m_book.Laps() : racer->lap + 1, m_book.Laps(), 0, 0, 0);
		}
	}
	m_book.Rank();
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		CBasePlayer* pPlayer = m_seats[index].in ? RacePlayer(index) : NULL;
		if (pPlayer)
			Status(index, pPlayer);
	}

	if (m_state == RACE_RACING && m_book.FinishedCount() > 0)
	{
		m_flFinishEnd = now + m_flFinishWait;
		SetState(RACE_FINISHED);
		if (m_book.StillRacing() > 0 && m_flFinishWait >= 1)
		{
			char text[80];
			snprintf(text, sizeof(text), "* The race ends in %d seconds\n", (int)m_flFinishWait);
			UTIL_ClientPrintAll(HUD_PRINTTALK, text);
		}
	}
	// the end: nobody left racing (all finished or out of time), or the others' time is up
	if (m_book.StillRacing() == 0 || (m_state == RACE_FINISHED && now >= m_flFinishEnd))
		Results();
}

// The table, on every screen and in every console; the next race is set up when it goes.
void CRaceRules::Results()
{
	if (m_state != RACE_FINISHED)
		SetState(RACE_FINISHED);
	m_book.Rank();
	m_flResultsEnd = gpGlobals->time + RACE_RESULTS_TIME;
	m_iResultsSerial++; // HudFrame sends the table to the games that draw it

	const RaceRacer* order[RACE_MAX_RACERS];
	const int count = m_book.Order(order, RACE_MAX_RACERS);
	char table[480];
	int length = snprintf(table, sizeof(table), "RACE RESULTS\n");
	UTIL_ClientPrintAll(HUD_PRINTCONSOLE, "RACE RESULTS\n");
	for (int i = 0; i < count; i++)
	{
		const RaceRacer* racer = order[i];
		CBasePlayer* pPlayer = RacePlayer(racer->id);
		char name[24];
		snprintf(name, sizeof(name), "%s", pPlayer ? STRING(pPlayer->pev->netname) : "?");
		char line[120];
		if (racer->finished)
			snprintf(line, sizeof(line), "%d. %s   %s   best %s\n", racer->place, name, RaceTime(racer->total), RaceTime(racer->bestLap));
		else
			snprintf(line, sizeof(line), "%d. %s   %s (lap %d/%d)\n", racer->place, name, racer->retired ? "out of time" : "did not finish",
				racer->lap + 1 > m_book.Laps() ? m_book.Laps() : racer->lap + 1, m_book.Laps());
		UTIL_ClientPrintAll(HUD_PRINTCONSOLE, line);
		if (i < 10 && length + (int)strlen(line) < (int)sizeof(table)) // ten lines fit a screen
			length += snprintf(table + length, sizeof(table) - length, "%s", line);
	}
	RaceText(NULL, RACE_CHANNEL_STATUS, 0.02f, 0.30f, 255, 200, 60, 0.1f, " "); // the status lines go
	RaceText(NULL, RACE_CHANNEL_TABLE, -1, 0.42f, 255, 255, 255, RACE_RESULTS_TIME, table);
	ALERT(at_console, "race: results (%d racers, %d finished)\n", count, m_book.FinishedCount());
}

bool CRaceRules::Holds(CBasePlayer* pPlayer)
{
	if (!Valid() || !pPlayer)
		return false;
	if (m_state == RACE_COUNTDOWN || m_flResultsEnd > 0)
		return true;
	if (Rally())
		return false; // a finished racer in rally mode is not held: his car brakes and coasts (pmove, key "rfin")
	const RaceRacer* racer = m_book.Find(pPlayer->entindex());
	return m_book.Running() && racer && (racer->finished || racer->retired);
}

// A rally racer who has crossed the finish or run out of time: his car brakes and then coasts, as HL Rally's does.
bool CRaceRules::FinishedCar(CBasePlayer* pPlayer)
{
	if (!Valid() || !pPlayer || !Rally())
		return false;
	const RaceRacer* racer = m_book.Find(pPlayer->entindex());
	return m_book.Running() && racer && (racer->finished || racer->retired);
}

// Finished the last lap or out of time: HL Rally's `pev->iuser3 == numlaps`.
bool CRaceRules::Done(CBasePlayer* pPlayer) const
{
	const RaceRacer* racer = pPlayer ? m_book.Find(pPlayer->entindex()) : NULL;
	return m_book.Running() && racer && (racer->finished || racer->retired);
}

// His car on its slot (a car change before the race, or a mid-race one that keeps him in it), if he has one.
void CRaceRules::PutOnSlot(CBasePlayer* pPlayer)
{
	const int index = pPlayer ? pPlayer->entindex() : 0;
	if (index < 1 || index > RACE_MAX_PLAYERS || !m_seats[index].in)
		return;
	Vector origin, angles;
	if (RaceGridSlot(m_seats[index].slot, origin, angles))
	{
		RallyPut(pPlayer, origin, angles);
		Placed(pPlayer);
	}
}

int CRaceRules::SlotOf(CBasePlayer* pPlayer)
{
	const int index = pPlayer ? pPlayer->entindex() : 0;
	if (index < 1 || index > RACE_MAX_PLAYERS || !m_seats[index].in)
		return 0;
	return m_seats[index].slot;
}

bool CRaceRules::RespawnPoint(CBasePlayer* pPlayer, Vector& origin, Vector& angles)
{
	if (!pPlayer)
		return false;
	const RaceRacer* racer = m_book.Find(pPlayer->entindex());
	if (racer && m_book.Running() && racer->last >= 0)
	{
		// the last checkpoint passed, or the nearest before it that has a respawn (not past the line: before it
		// stands the grid)
		for (int number = racer->last; number >= 0; number--)
		{
			CBaseEntity* pEntity = NULL;
			while ((pEntity = UTIL_FindEntityByClassname(pEntity, "race_respawn")) != NULL)
			{
				if (static_cast<CRaceRespawn*>(pEntity)->m_iCheckpoint == number)
				{
					origin = pEntity->pev->origin;
					angles = pEntity->pev->angles;
					return true;
				}
			}
		}
	}
	return RaceGridSlot(SlotOf(pPlayer), origin, angles);
}

void CRaceRules::Placed(CBasePlayer* pPlayer)
{
	const int index = pPlayer ? pPlayer->entindex() : 0;
	if (index < 1 || index > RACE_MAX_PLAYERS)
		return;
	m_seats[index].hasLast = false;
	m_seats[index].inside = 0;
	m_book.Placed(index);
}

// ── rally mode: the racer is the player ──

// The speed along his nose, his slip (0..1) and his car's top speed: an h9_car's own numbers (fuser2, fuser4, fuser3), or
// the player's, from his velocity and heading.
void CRaceRules::DriveState(CBasePlayer* pPlayer, float& speed, float& slip, float& top) const
{
	if (Rally())
	{
		const RaceRallyDrive d = RaceRallyDriveOf(pPlayer->pev->velocity.x, pPlayer->pev->velocity.y, pPlayer->pev->v_angle.y, false,
			false, false, 0);
		speed = RaceRallyGaugeSpeed(d.speed);
		slip = d.slip;
		top = RaceRallyTopSpeed(H9RallyClassOf(pPlayer->entindex()), H9RallyTopAdd(pPlayer->entindex())); // his own car and parts
		return;
	}
	CBaseEntity* pCar = pPlayer->m_pTank;
	speed = pCar ? pCar->pev->fuser2 : 0;
	slip = pCar ? pCar->pev->fuser4 : 0;
	top = pCar ? pCar->pev->fuser3 : 0;
}

// Every seat is given up (the vehicle changed under it): the players are let go and rejoin by the other rule.
void CRaceRules::RallySeats()
{
	m_bWasRally = Rally();
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		Seat& seat = m_seats[index];
		if (!seat.in)
			continue;
		CBasePlayer* pPlayer = RacePlayer(index);
		if (pPlayer)
			RallyRelease(pPlayer);
		m_book.Remove(index);
		seat = Seat();
	}
}

// Held or not: the movement of a car that is held is refused in pmove on both sides (CarHeld in pm_shared/h9_rally.cpp
// reads FL_FROZEN only: the loadout's maxspeed is nothing to it). FL_FROZEN is in clientdata's `flags` (game/ts/delta.lst, 32
// bits), so the client's pmove has it.
void CRaceRules::RallyHold(int index, CBasePlayer* pPlayer, bool held)
{
	Seat& seat = m_seats[index];
	if (held == seat.frozen)
		return;
	seat.frozen = held;
	if (held)
		pPlayer->pev->flags |= FL_FROZEN;
	else
		pPlayer->pev->flags &= ~FL_FROZEN;
}

// A racer who goes out of the race (left, died, the vehicle changed) is not held any more.
void CRaceRules::RallyRelease(CBasePlayer* pPlayer)
{
	pPlayer->pev->flags &= ~FL_FROZEN;
}

// The player on a place, facing its way, at rest. The heading is the view yaw (pmove steers by cmd.viewangles), so the
// view is set with fixangle.
void CRaceRules::RallyPut(CBasePlayer* pPlayer, const Vector& origin, const Vector& angles)
{
	entvars_t* pev = pPlayer->pev;
	UTIL_SetOrigin(pev, origin);
	pev->velocity = g_vecZero;
	pev->basevelocity = g_vecZero;
	pev->avelocity = g_vecZero;
	pev->punchangle = g_vecZero;
	pev->angles = Vector(0, angles.y, 0);
	pev->v_angle = Vector(0, angles.y, 0);
	pev->fixangle = 1;
	pev->flags &= ~FL_ONGROUND;
	pev->groundentity = NULL;
}

// Who is racing, in rally mode: a living player in the map who is not an observer. A newcomer gets the lowest slot free
// and is put on it (in the warm-up, the countdown, or in the middle of a race, from lap 0 and not held; not while a race
// is ending: he is a free car until the next one). A player the grid has no slot for drives free.
void CRaceRules::RallyRoster()
{
	bool used[RACE_MAX_PLAYERS + 2] = {};
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
		if (m_seats[index].in && m_seats[index].slot >= 1 && m_seats[index].slot <= RACE_MAX_PLAYERS)
			used[m_seats[index].slot] = true;
	for (int index = 1; index <= gpGlobals->maxClients && index <= RACE_MAX_PLAYERS; index++)
	{
		Seat& seat = m_seats[index];
		CBasePlayer* pPlayer = RacePlayer(index);
		// a racer is a living player who has chosen a car (HL Rally's fuser1) and is not sitting this race out
		if (pPlayer && (!pPlayer->IsAlive() || pPlayer->IsObserver() || !H9RallyChosen(index) || s_sitOut[index]))
		{
			if (seat.in)
				RallyRelease(pPlayer);
			pPlayer = NULL;
		}
		if (!pPlayer)
		{
			if (seat.in)
			{
				used[seat.slot] = false;
				m_book.Remove(index);
				seat = Seat();
			}
			continue;
		}
		if (seat.in || m_state == RACE_FINISHED)
			continue;
		const int slot = RaceLowestFreeSlot(used, m_iGrid);
		if (slot == 0)
			continue; // the grid is full
		Vector origin, angles;
		if (!RaceGridSlot(slot, origin, angles))
			continue;
		used[slot] = true;
		seat = Seat();
		seat.in = true;
		seat.slot = slot;
		m_book.Add(index);
		if (m_state == RACE_WAITING)
			m_flWarmEnd = 0; // the warm-up begins again
		RallyPut(pPlayer, origin, angles);
		Placed(pPlayer);
		ALERT(at_console, "race: %s takes grid slot %d\n", STRING(pPlayer->pev->netname), slot);
	}
}

// HL Rally's `kill` (its put-back): RaceRallyAskPut sets it, the racer's next rally frame takes it as a press of the put-back key.
static bool s_putAsked[RACE_MAX_PLAYERS + 1];
static bool TakePutAsked(int index)
{
	const bool asked = s_putAsked[index];
	s_putAsked[index] = false;
	return asked;
}

// Each racer's frame in rally mode: held or not, his livery, the two state bytes for other clients, the reset key, and
// the watch for the world's edge and deep water.
void CRaceRules::RallyFrame(float dt)
{
	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		Seat& seat = m_seats[index];
		CBasePlayer* pPlayer = seat.in ? RacePlayer(index) : NULL;
		if (!pPlayer)
			continue;
		entvars_t* pev = pPlayer->pev;
		const bool held = Holds(pPlayer);
		RallyHold(index, pPlayer, held);
		pev->skin = RaceRallySkin(seat.slot);

		// the put-back key (HL Rally's `k`, ClientKill): at once on the press, a second's rest after one; the respawn of the
		// last checkpoint passed, one unit up, at rest. There is no automatic put-back: a car that falls out of the world or
		// into water stays there, as in HL Rally.
		if (seat.putKey.Press((pev->button & IN_RELOAD) != 0 || TakePutAsked(index), gpGlobals->time))
		{
			Vector origin, angles;
			if (RespawnPoint(pPlayer, origin, angles))
			{
				RallyPut(pPlayer, origin + Vector(0, 0, 1), angles);
				Placed(pPlayer);
			}
		}

		// the state bytes: what he stands on is read twice a second, down from his origin
		const float now = gpGlobals->time;
		if (now >= seat.nextLook || now < seat.nextLook - 1.0f)
		{
			seat.nextLook = now + 0.5f;
			TraceResult tr;
			UTIL_TraceLine(pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64), ignore_monsters, pPlayer->edict(), &tr);
			const char* name = NULL;
			if (tr.flFraction < 1.0f)
			{
				edict_t* hit = tr.pHit && !FNullEnt(tr.pHit) ? tr.pHit : ENT(0);
				name = TRACE_TEXTURE(hit, pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64));
				if (!name && hit != ENT(0))
					name = TRACE_TEXTURE(ENT(0), pev->origin + Vector(0, 0, 1), pev->origin - Vector(0, 0, 64));
			}
			if (name && (*name == '-' || *name == '+') && name[1])
				name += 2;
			seat.surface = RaceSurfaceByte(H9RallySurfaceByName(name), pev->waterlevel >= 1);
		}
		const bool airborne = !(pev->flags & FL_ONGROUND) && pev->waterlevel < 2;
		const RaceRallyDrive d = RaceRallyDriveOf(pev->velocity.x, pev->velocity.y, pev->v_angle.y, airborne,
			(pev->button & IN_BACK) != 0, (pev->button & IN_JUMP) != 0, seat.surface);
		pev->blending[0] = (byte)d.blending0;
		pev->blending[1] = (byte)d.blending1;
	}
}

// ── the client's HUD (race.h lists the messages; cl_dll/h9_racehud.cpp reads them) ──

int gmsgRallyLight = 0; // H9RLight: a rally car's headlights (byte entindex, byte on), HL Rally's Flashlight message
int gmsgRaceStat = 0, gmsgRaceState = 0, gmsgRaceNote = 0, gmsgRaceLine = 0, gmsgRacePos = 0, gmsgRaceRes = 0;

void RaceLinkUserMessages()
{
	if (gmsgRaceStat != 0)
		return;
	gmsgRaceStat = REG_USER_MSG("H9RStat", RACE_MSG_STAT_SIZE);
	gmsgRaceState = REG_USER_MSG("H9RState", RACE_MSG_STATE_SIZE);
	gmsgRaceNote = REG_USER_MSG("H9RNote", RACE_MSG_NOTE_SIZE);
	gmsgRaceLine = REG_USER_MSG("H9RLine", -1);
	gmsgRacePos = REG_USER_MSG("H9RPos", -1);
	gmsgRaceRes = REG_USER_MSG("H9RRes", -1);
	gmsgRallyLight = REG_USER_MSG("H9RLight", 2);
}

// Seconds as hundredths, to the nearest.
static int RaceHundredths(float seconds)
{
	return (int)floorf(seconds * 100.0f + 0.5f);
}

// A map coordinate as the HUD's messages carry it.
static int RaceHudCoord(float value)
{
	const int scaled = (int)floorf(value / RACE_HUD_COORD + 0.5f);
	return scaled < -32768 ? -32768 : (scaled > 32767 ? 32767 : scaled);
}

static int RaceByte(int value)
{
	return value < 0 ? 0 : (value > 255 ? 255 : value);
}

// Every frame, from the think (the server's clock): who has the HUD, and what each of them is owed.
void CRaceRules::HudFrame()
{
	const float now = gpGlobals->time;

	// what everybody is told when it changes
	HudState state;
	state.state = m_state;
	state.laps = m_book.Laps();
	state.racers = Racers();
	state.results = m_flResultsEnd > 0;
	switch (m_state)
	{
	case RACE_WAITING: state.t0 = m_flWarmEnd; break;
	case RACE_COUNTDOWN: state.t0 = m_flGo; break;
	case RACE_RACING: state.t0 = m_book.StartTime(); break;
	case RACE_FINISHED: state.t0 = m_flFinishEnd; break;
	}
	if (state.state != m_hudState.state || state.laps != m_hudState.laps || state.racers != m_hudState.racers ||
		state.results != m_hudState.results || state.t0 != m_hudState.t0)
	{
		m_hudState = state;
		m_iHudSerial++;
	}

	for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
	{
		Hud& hud = m_hud[index];
		CBasePlayer* pPlayer = index <= gpGlobals->maxClients ? RacePlayer(index) : NULL;
		// A user message reaches only a game that is in the map (the engine drops it before); m_fGameHUDInitialized is
		// set when the player's first HUD messages have gone.
		if (!pPlayer || !pPlayer->IsNetClient() || !pPlayer->m_fGameHUDInitialized)
		{
			hud = Hud();
			continue;
		}
		const int userid = GETPLAYERUSERID(pPlayer->edict());
		if (userid != hud.userid)
		{
			hud = Hud();
			hud.userid = userid;
		}
		if (now >= hud.nextAsk || now < hud.nextAsk - 1.0f)
		{
			hud.nextAsk = now + 0.5f;
			const char* value = g_engfuncs.pfnInfoKeyValue(g_engfuncs.pfnGetInfoKeyBuffer(pPlayer->edict()), RACE_HUD_INFOKEY);
			const bool on = value && atoi(value) != 0;
			if (on != hud.on)
			{
				hud = Hud(); // from the beginning, either way
				hud.userid = userid;
				hud.on = on;
				hud.nextAsk = now + 0.5f;
				ALERT(at_aiconsole, "race: %s %s the race HUD\n", STRING(pPlayer->pev->netname), on ? "has" : "has not");
			}
		}
		if (!hud.on)
			continue;

		if (hud.lineStage < 2 && HudLinePart(pPlayer, hud))
			continue; // one part a frame, and nothing else in that frame
		if (hud.stateSerial != m_iHudSerial)
		{
			hud.stateSerial = m_iHudSerial;
			HudSendState(pPlayer);
		}
		if (m_flResultsEnd > 0 && hud.resultsSerial != m_iResultsSerial)
		{
			hud.resultsSerial = m_iResultsSerial;
			HudSendResults(pPlayer);
		}
		if (!m_seats[index].in || !m_book.Find(index))
			continue;
		if (now >= hud.nextStatus || now < hud.nextStatus - 1.0f)
		{
			hud.nextStatus = now + RACE_HUD_STATUS_EVERY;
			HudSendStatus(index, pPlayer);
		}
		if (now >= hud.nextPos || now < hud.nextPos - 1.0f)
		{
			hud.nextPos = now + RACE_HUD_POS_EVERY;
			HudSendPositions(pPlayer);
		}
	}
}

// The next part of the lap's line, or of the checkpoints; false when there was nothing left to send.
bool CRaceRules::HudLinePart(CBasePlayer* pPlayer, Hud& hud)
{
	for (; hud.lineStage < 2; hud.lineStage++, hud.lineSent = 0)
	{
		const int kind = hud.lineStage;
		const int total = kind == 0 ? m_iMarks : m_iCheckpoints;
		int count = total - hud.lineSent;
		if (count > RACE_HUD_LINE_POINTS)
			count = RACE_HUD_LINE_POINTS;
		// a map with no line still sends one empty part of kind 0: it takes the line of the map before away
		if (count <= 0 && !(kind == 0 && total == 0 && hud.lineSent == 0))
			continue;
		MESSAGE_BEGIN(MSG_ONE, gmsgRaceLine, NULL, pPlayer->pev);
		WRITE_BYTE(kind);
		WRITE_SHORT(total);
		WRITE_SHORT(hud.lineSent);
		WRITE_BYTE(count);
		for (int i = 0; i < count; i++)
		{
			const Vector& at = kind == 0 ? m_marks[hud.lineSent + i].at : m_checkpoints[hud.lineSent + i].centre;
			WRITE_SHORT(RaceHudCoord(at.x));
			WRITE_SHORT(RaceHudCoord(at.y));
		}
		MESSAGE_END();
		hud.lineSent += count;
		if (hud.lineSent >= total)
		{
			hud.lineStage++;
			hud.lineSent = 0;
		}
		return true;
	}
	return false;
}

void CRaceRules::HudSendState(CBasePlayer* pPlayer)
{
	const int tenths = (int)(CountdownLen() * 10.0f + 0.5f);
	MESSAGE_BEGIN(MSG_ONE, gmsgRaceState, NULL, pPlayer->pev);
	WRITE_BYTE(m_hudState.state);
	WRITE_BYTE(m_hudState.results ? 1 : 0);
	WRITE_BYTE(RaceByte(m_hudState.laps));
	WRITE_BYTE(RaceByte(m_hudState.racers));
	WRITE_FLOAT(gpGlobals->time);
	WRITE_FLOAT(m_hudState.t0);
	WRITE_SHORT(tenths > 32767 ? 32767 : tenths);
	MESSAGE_END();
}

void CRaceRules::HudSendStatus(int index, CBasePlayer* pPlayer)
{
	const RaceRacer* racer = m_book.Find(index);
	if (!racer)
		return;
	const bool running = m_book.Running(); // false in the warm-up and the countdown: the book still holds the race before
	const int laps = m_book.Laps();
	int flags = 0;
	if (running && racer->wrongWay)
		flags |= RACE_SF_WRONGWAY;
	if (running && racer->finished)
		flags |= RACE_SF_FINISHED;
	if (running && racer->retired)
		flags |= RACE_SF_RETIRED;
	float speed, slip, top;
	DriveState(pPlayer, speed, slip, top); // the speed along the nose, the slip, the top speed
	speed = speed < -32000 ? -32000 : (speed > 32000 ? 32000 : speed);
	const float limit = running && m_flMaxTime > 0 ? m_book.StartTime() + m_flMaxTime + racer->bonus : 0;

	MESSAGE_BEGIN(MSG_ONE_UNRELIABLE, gmsgRaceStat, NULL, pPlayer->pev);
	WRITE_BYTE(m_state);
	WRITE_BYTE(flags);
	WRITE_BYTE(RaceByte(running ? (racer->lap + 1 > laps ? laps : racer->lap + 1) : 1));
	WRITE_BYTE(RaceByte(laps));
	WRITE_BYTE(RaceByte(running ? (racer->finished ? racer->finishPlace : racer->place) : 0));
	WRITE_BYTE(RaceByte(Racers()));
	WRITE_SHORT((int)speed);
	WRITE_BYTE(RaceByte((int)(slip * 255.0f + 0.5f)));
	WRITE_SHORT(top > 0 && top < 32000 ? (int)top : 0);
	WRITE_FLOAT(gpGlobals->time);
	WRITE_FLOAT(m_book.StartTime());
	WRITE_FLOAT(racer->lapStart);
	WRITE_FLOAT(limit);
	WRITE_LONG(running && racer->bestLap > 0 ? RaceHundredths(racer->bestLap) : 0);
	WRITE_LONG(running && racer->finished ? RaceHundredths(racer->total) : 0);
	WRITE_FLOAT(m_flMaxTime > 0 ? m_flMaxTime : 0); // the allowance, for the rally HUD's clock before the green light (HL Rally's TimeExtension)
	MESSAGE_END();
}

// How far a racer has come since the green light, along the lap's line: the laps he has closed, the line up to
// his next checkpoint, less what he still has to go to it. For the gaps of H9RPos only (the places are the book's).
float CRaceRules::HudProgress(const RaceRacer& racer) const
{
	float toNext = m_flLine; // the line itself is next: a whole lap from the line
	if (racer.next > 0 && racer.next < m_iCheckpoints)
	{
		toNext = m_checkpoints[racer.next].along - m_checkpoints[0].along;
		if (toNext < 0)
			toNext += m_flLine;
	}
	return racer.lap * m_flLine + toNext - racer.distance;
}

// Where every racer is, his place, and how far behind the first still racing.
void CRaceRules::HudSendPositions(CBasePlayer* pPlayer)
{
	const bool running = m_book.Running();
	const bool measured = running && m_iMarks > 0 && m_flLine > 0;
	float lead = 0;
	bool hasLead = false;
	if (measured)
	{
		for (int index = 1; index <= RACE_MAX_PLAYERS; index++)
		{
			const RaceRacer* racer = m_seats[index].in ? m_book.Find(index) : NULL;
			if (!racer || racer->finished || racer->retired || !racer->hasDistance)
				continue;
			const float progress = HudProgress(*racer);
			if (!hasLead || progress > lead)
				lead = progress;
			hasLead = true;
		}
	}
	int index = 1;
	bool first = true;
	do
	{
		// the racers of this part
		int ids[RACE_HUD_POS_RACERS];
		int count = 0;
		for (; index <= RACE_MAX_PLAYERS && count < RACE_HUD_POS_RACERS; index++)
		{
			if (m_seats[index].in && m_book.Find(index) && RacePlayer(index))
				ids[count++] = index;
		}
		MESSAGE_BEGIN(MSG_ONE_UNRELIABLE, gmsgRacePos, NULL, pPlayer->pev);
		WRITE_BYTE(first ? RACE_PF_FIRST : 0);
		WRITE_BYTE(count);
		for (int i = 0; i < count; i++)
		{
			const RaceRacer* racer = m_book.Find(ids[i]);
			const Vector at = RacePosition(RacePlayer(ids[i]));
			int place = running ? ((racer->finished ? racer->finishPlace : racer->place) & RACE_PP_PLACE) : 0;
			if (running && racer->finished)
				place |= RACE_PP_FINISHED;
			if (running && racer->retired)
				place |= RACE_PP_RETIRED;
			int gap = 0xFFFF;
			if (measured && hasLead && racer->hasDistance && !racer->finished && !racer->retired)
			{
				const float behind = (lead - HudProgress(*racer)) / RACE_HUD_GAP;
				gap = behind < 0 ? 0 : (behind > 65534 ? 65534 : (int)behind);
			}
			WRITE_BYTE(ids[i]);
			WRITE_BYTE(place);
			WRITE_SHORT(RaceHudCoord(at.x));
			WRITE_SHORT(RaceHudCoord(at.y));
			WRITE_SHORT(gap);
		}
		MESSAGE_END();
		first = false;
	} while (index <= RACE_MAX_PLAYERS);
}

// The results, in the order of the places, RACE_HUD_RES_ROWS to a message.
void CRaceRules::HudSendResults(CBasePlayer* pPlayer)
{
	const RaceRacer* order[RACE_MAX_RACERS];
	const int total = m_book.Order(order, RACE_MAX_RACERS);
	const int laps = m_book.Laps();
	for (int first = 0; first < total; first += RACE_HUD_RES_ROWS)
	{
		const int count = total - first < RACE_HUD_RES_ROWS ? total - first : RACE_HUD_RES_ROWS;
		MESSAGE_BEGIN(MSG_ONE, gmsgRaceRes, NULL, pPlayer->pev);
		WRITE_BYTE(first);
		WRITE_BYTE(total);
		WRITE_BYTE(RaceByte(laps));
		WRITE_BYTE(count);
		for (int i = 0; i < count; i++)
		{
			const RaceRacer* racer = order[first + i];
			WRITE_BYTE(RaceByte(racer->place));
			WRITE_BYTE(RaceByte(racer->id));
			WRITE_BYTE((racer->finished ? RACE_RF_FINISHED : 0) | (racer->retired ? RACE_RF_RETIRED : 0));
			WRITE_BYTE(RaceByte(racer->lap + 1 > laps ? laps : racer->lap + 1));
			WRITE_LONG(racer->finished ? RaceHundredths(racer->total) : 0);
			WRITE_LONG(racer->bestLap > 0 ? RaceHundredths(racer->bestLap) : 0);
		}
		MESSAGE_END();
	}
}

// What a racer is told in the middle of his screen; nothing to a game without the HUD (it had the text).
void CRaceRules::HudNote(int index, CBasePlayer* pPlayer, int kind, int a, int b, int flags, float time, float diff)
{
	if (!HudOn(index))
		return;
	MESSAGE_BEGIN(MSG_ONE, gmsgRaceNote, NULL, pPlayer->pev);
	WRITE_BYTE(kind);
	WRITE_BYTE(RaceByte(a));
	WRITE_BYTE(RaceByte(b));
	WRITE_BYTE(flags);
	WRITE_LONG(RaceHundredths(time));
	WRITE_LONG(RaceHundredths(diff));
	MESSAGE_END();
}

// ── the face (race.h) ──

bool RaceRallyRunning()
{
	return RaceActive() && g_pRace->Running();
}

bool RaceRallyDone(CBasePlayer* pPlayer)
{
	return RaceActive() && g_pRace->Done(pPlayer);
}

void RaceRallySitOut(int index, bool out)
{
	if (index >= 1 && index <= RACE_MAX_PLAYERS)
		s_sitOut[index] = out;
}

bool RaceRallySittingOut(int index)
{
	return index >= 1 && index <= RACE_MAX_PLAYERS && s_sitOut[index];
}

void RaceRallyPutOnSlot(CBasePlayer* pPlayer)
{
	if (RaceActive())
		g_pRace->PutOnSlot(pPlayer);
}

bool RaceRallyJoinMidRace()
{
	return mp_joinmidrace.value != 0;
}

bool RaceRallyAskPut(int index)
{
	if (!RaceActive() || index < 1 || index > RACE_MAX_PLAYERS)
		return false;
	s_putAsked[index] = true;
	return true;
}

bool RaceActive()
{
	return g_pRace != NULL && g_pRace->Valid();
}

RaceState RaceGetState()
{
	return RaceActive() ? g_pRace->State() : RACE_WAITING;
}

int RaceRound()
{
	return RaceActive() ? g_pRace->Round() : 0;
}

int RaceRallyClass()
{
	if (!g_pRace)
		return 0;
	return RaceRallyClassFor(g_pRace->RallyKey(), H9RallyCvarClass());
}

bool RaceRallyMapKey()
{
	return g_pRace != nullptr && g_pRace->RallyKey();
}

bool RaceRallyMode()
{
	return RaceRallyClass() > 0;
}

bool RaceHolds(CBasePlayer* pPlayer)
{
	return RaceActive() && g_pRace->Holds(pPlayer);
}

bool RaceFinishedCar(CBasePlayer* pPlayer)
{
	return RaceActive() && g_pRace->FinishedCar(pPlayer);
}

int RacePlayerSlot(CBasePlayer* pPlayer)
{
	return RaceActive() ? g_pRace->SlotOf(pPlayer) : 0;
}

bool RaceGridSlot(int slot, Vector& origin, Vector& angles)
{
	CBaseEntity* pEntity = NULL;
	while ((pEntity = UTIL_FindEntityByClassname(pEntity, "race_grid")) != NULL)
	{
		if (static_cast<CRaceGrid*>(pEntity)->m_iSlot == slot)
		{
			origin = pEntity->pev->origin;
			angles = pEntity->pev->angles;
			return true;
		}
	}
	return false;
}

bool RaceRespawnPoint(CBasePlayer* pPlayer, Vector& origin, Vector& angles)
{
	return RaceActive() && g_pRace->RespawnPoint(pPlayer, origin, angles);
}

void RacePlaced(CBasePlayer* pPlayer)
{
	if (RaceActive())
		g_pRace->Placed(pPlayer);
}

bool RaceWaypoint(int number, Vector& origin, float& speed, float& spread)
{
	CBaseEntity* pEntity = NULL;
	while ((pEntity = UTIL_FindEntityByClassname(pEntity, "race_waypoint")) != NULL)
	{
		CRaceWaypoint* pWaypoint = static_cast<CRaceWaypoint*>(pEntity);
		if (pWaypoint->m_iNumber == number)
		{
			origin = pWaypoint->pev->origin;
			speed = pWaypoint->m_flSpeed;
			spread = pWaypoint->m_flSpread;
			return true;
		}
	}
	return false;
}
