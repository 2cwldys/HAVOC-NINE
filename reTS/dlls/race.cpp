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
*                     (key model, default models/race/rc_gantry.mdl) that names itself race_gantry
*
*  The HUD is server text only (TE_TEXTMESSAGE on four channels), sent a few times a second at most.
*  Cvars: mp_racelaps (0 = the map's `laps`), mp_racewarmup (seconds before each countdown, 10).
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "race.h"
#include "race_book.h"

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

void RaceRegisterCvars()
{
	CVAR_REGISTER(&mp_racelaps);
	CVAR_REGISTER(&mp_racewarmup);
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
			pev->model = MAKE_STRING("models/race/rc_gantry.mdl");
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
	int SlotOf(CBasePlayer* pPlayer);
	bool RespawnPoint(CBasePlayer* pPlayer, Vector& origin, Vector& angles);
	void Placed(CBasePlayer* pPlayer);

private:
	struct Checkpoint
	{
		bool present = false;
		Vector mins, maxs, centre;
		float bonus = 0;
	};
	// A player the race knows: his grid slot and what it saw of him the frame before.
	struct Seat
	{
		bool in = false;
		int slot = 0;
		Vector last;
		bool hasLast = false;
		unsigned long long inside = 0; // the checkpoints his last move met, one bit each
		float nextStatus = 0, nextWarn = 0;
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

	// settings (keys)
	int m_iLaps = 3;
	float m_flCountdown = 5, m_flMaxTime = 0, m_flFinishWait = 30;

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
	if (pPlayer)
		UTIL_HudMessage(pPlayer, parms, text);
	else
		UTIL_HudMessageAll(parms, text);
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
	ALERT(at_console, "race_rules: %d checkpoints, %d laps, countdown %.0f s, finishwait %.0f s, maxtime %.0f s\n",
		m_iCheckpoints, m_iLaps, m_flCountdown, m_flFinishWait, m_flMaxTime);
}

// Who is on the server: a newcomer gets the lowest grid slot free and joins the book; one who left gives his
// slot back.
void CRaceRules::Roster()
{
	for (int index = 1; index <= gpGlobals->maxClients && index <= RACE_MAX_PLAYERS; index++)
	{
		Seat& seat = m_seats[index];
		CBasePlayer* pPlayer = RacePlayer(index);
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
		int slot = 1;
		for (int other = 1; other <= RACE_MAX_PLAYERS; other++)
		{
			if (m_seats[other].in && m_seats[other].slot == slot)
			{
				slot++;
				other = 0; // look again from the first
			}
		}
		seat = Seat();
		seat.in = true;
		seat.slot = slot;
		m_book.Add(index);
		ALERT(at_console, "race: %s takes grid slot %d\n", STRING(pPlayer->pev->netname), slot);
	}
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
	Roster();
	if (m_flGantryOff > 0 && now >= m_flGantryOff)
	{
		m_flGantryOff = 0;
		Gantry(0);
	}

	switch (m_state)
	{
	case RACE_WAITING: Wait(); break;
	case RACE_COUNTDOWN: Countdown(); break;
	case RACE_RACING:
	case RACE_FINISHED: Race(dt); break;
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
	m_flGo = now + m_flCountdown;
	m_iRound++; // the cars go to the grid (the car reads RaceRound)
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
	int reds = 1 + (int)((m_flCountdown - left) / m_flCountdown * 4);
	Gantry(reds < 1 ? 1 : (reds > 4 ? 4 : reds));
	const int number = (int)ceilf(left);
	if (number != m_iShown)
	{
		m_iShown = number;
		char text[16];
		snprintf(text, sizeof(text), "%d", number);
		RaceBig(NULL, 255, 60, 40, 1.1f, text);
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
		m_book.Progress(index, (m_checkpoints[racer->next].centre - at).Length(), dt);
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
		break;
	case RACE_EV_LAP:
		snprintf(text, sizeof(text), "LAP %d   %s%s", racer->lap, RaceTime(racer->lastLap), racer->lastLap <= racer->bestLap ? "   BEST LAP" : "");
		RaceNote(pPlayer, 255, 255, 120, text);
		break;
	case RACE_EV_FINISH:
		snprintf(text, sizeof(text), "FINISH\n%s   %s", RaceOrdinal(racer->finishPlace), RaceTime(racer->total));
		RaceBig(pPlayer, 60, 255, 80, 5.0f, text);
		snprintf(text, sizeof(text), "* %s finishes %s in %s (best lap %s)\n", STRING(pPlayer->pev->netname),
			RaceOrdinal(racer->finishPlace), RaceTime(racer->total), RaceTime(racer->bestLap));
		UTIL_ClientPrintAll(HUD_PRINTTALK, text);
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
	if (!racer || !pPlayer->IsNetClient())
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
			snprintf(text, sizeof(text), "LAP %d/%d   POS %d/%d\nTIME %s\nLAP  %s\nBEST %s%s", racer->lap + 1, laps, racer->place,
				Racers(), RaceTime(now - m_book.StartTime(), true), RaceTime(now - racer->lapStart, true), best, left);
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
	const RaceRacer* racer = m_book.Find(pPlayer->entindex());
	return m_book.Running() && racer && (racer->finished || racer->retired);
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

// ── the face (race.h) ──

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

bool RaceHolds(CBasePlayer* pPlayer)
{
	return RaceActive() && g_pRace->Holds(pPlayer);
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
