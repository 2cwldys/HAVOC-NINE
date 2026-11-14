/***
*  h9_rally_srv.cpp -- the server's side of rally mode (H9): the cvar and the per-player switch.
*
*  h9_rally 0 is off (the default). 1 to 10 turns on rally mode for every player, who then drives as that car
*  class (pm_shared/h9_rally.h's table: 1 rally, 2 sprint, 3 heavy): the player IS the car, moved by pmove on both
*  sides (pm_shared/h9_rally.cpp). The only thing the client needs from here is the physinfo key "rally", which the
*  engine sends in the client data. Each frame this makes the player's state match the cvar: the key, no weapons, the
*  car's size for other entities, and, when the mode goes off, the standing size and a lift out of the floor.
*  A race map in rally mode (race.cpp) asks for class 1 through RaceRallyClass() when the cvar is 0. The grid, the
*  holds and the car's model are the race's (race.cpp), not this file's.
*
*  While rally mode is on for the map, the server's movement settings are HL Rally's (its rally.cfg): sv_friction 0.25,
*  sv_accelerate 0.085, sv_gravity 520, sv_stepsize 4. pmove reads them live from its movevars (pm_shared/h9_rally.cpp), as HL Rally's
*  does. The values found are kept and put back when the mode goes off (see ApplyMovevars). They are the server's for every
*  player, so a player who is not a car (a spectator, a dead player) moves by them too while the map runs; that is how HL Rally's own
*  server runs, and a rally race map has nobody on foot.
***/
#include "extdll.h"
#include "util.h"
#include "cbase.h"
#include "player.h"
#include "h9_rally_srv.h"
#include "h9_rally_snd.h"
#include "h9_rally_car.h"
#include "race.h"
#include "h9_rally.h" // the settings HL Rally's server runs with
#include "pm_defs.h"
#include "pm_shared.h" // PM_Move: H9RallyPMMove calls it
#include "h9_rally_shop_srv.h" // the car menu's rules: money, parts, the car chosen
#include "UserMessages.h"
#include "ts_utils.h" // TSHudMessageOne
#include "entity_state.h" // clientdata_s

extern int gmsgRallyLight; // race.cpp

float GetSpeedBySlots(CBasePlayer* pPlayer); // ts_gun.cpp

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

static cvar_t h9_rally = {"h9_rally", "0", FCVAR_SERVER};
// 1: each rally player's movement prints one line every half second to the server console (pm_shared/h9_rally.cpp, DebugLine).
// pmove reaches no cvar of ours, so the flag goes to it in the physinfo key "rdbg", as "rally" does.
static cvar_t h9_rally_debug = {"h9_rally_debug", "0", 0};
// 1 (the default): every rally car's pmove command is written as a CSV line to <gamedir>/rallylog/srv_<map>_<date-time>.txt
// (pm_shared/h9_rallylog.h has the columns). 0: no file.
static cvar_t h9_rally_log = {"h9_rally_log", "1", FCVAR_ARCHIVE};

// What a car is told its speed limit is: nothing of The Specialists' loadout (SetPlayerSpeed: 0..330) may clamp it. Rally's own
// movement does not read maxspeed (the wish speed is the car's stat), but PM_CheckParamters scales the command by it first.
#define H9RALLY_MAXSPEED 3000.0f // HL Rally's sv_maxspeed

// The movement cvars HL Rally's rally.cfg sets, and the values they had when the mode came on. world.cpp sets sv_gravity and
// sv_stepsize again at every map load, so a restore only puts back a value that is still the rally one: a map's own is left alone.
// sv_maxspeed is the fifth: PM_CheckParamters scales the command's forward move down to the movevars' maxspeed, and the car's move is the
// client's gearbox number (up to 10000), so a server that kept The Specialists' 320 would cut every car to 320 u/s of wish.
// sv_airaccelerate is the sixth: PM_AirMove (pm_shared.c:1811) air-accelerates a forward move with it (rally.cfg: 0.1).
#define H9RALLY_NUM_MOVEVARS 6
static const char* const kMoveVars[H9RALLY_NUM_MOVEVARS] = {"sv_friction", "sv_accelerate", "sv_gravity", "sv_stepsize", "sv_maxspeed", "sv_airaccelerate"};
static const float kRallyValues[H9RALLY_NUM_MOVEVARS] = {H9R_FRICTION, H9R_ACCELERATE, H9R_GRAVITY, H9R_STEP_UP, H9RALLY_MAXSPEED, H9R_AIRACCELERATE};
static float s_savedValues[H9RALLY_NUM_MOVEVARS];
static bool s_movevarsApplied = false;

static void ApplyMovevars(bool rally)
{
	if (rally)
	{
		if (!s_movevarsApplied)
		{
			for (int i = 0; i < H9RALLY_NUM_MOVEVARS; i++)
				s_savedValues[i] = CVAR_GET_FLOAT(kMoveVars[i]);
			s_movevarsApplied = true;
		}
		for (int i = 0; i < H9RALLY_NUM_MOVEVARS; i++)
			if (CVAR_GET_FLOAT(kMoveVars[i]) != kRallyValues[i])
				CVAR_SET_FLOAT(kMoveVars[i], kRallyValues[i]);
	}
	else if (s_movevarsApplied)
	{
		for (int i = 0; i < H9RALLY_NUM_MOVEVARS; i++)
			if (CVAR_GET_FLOAT(kMoveVars[i]) == kRallyValues[i])
				CVAR_SET_FLOAT(kMoveVars[i], s_savedValues[i]);
		s_movevarsApplied = false;
	}
}

void H9RallyRegisterCvars()
{
	CVAR_REGISTER(&h9_rally);
	CVAR_REGISTER(&h9_rally_debug);
	CVAR_REGISTER(&h9_rally_log);
}

// ---- the log (pm_shared/h9_rallylog.h) -----------------------------------------------------------------------------------------------
// pmove cannot open a file (the same code is the client's), so H9RallyMove leaves a record of each server command in g_h9RallyLogRec and
// the engine's call of PM_Move comes through here (dlls/cbase.cpp's pfnPM_Move): the record is written after PM_Move returns, one CSV line
// to rallylog/srv_<map>_<date-time>.txt in the game folder, a new file for each map load.
static H9RallyLogFile s_log;
static char s_logMap[64] = "";
static float s_logLastTime = 0;
static int s_logSeq = 0;

void H9RallyPMMove(struct playermove_s* ppmove, qboolean server)
{
	const bool want = server != 0 && h9_rally_log.value != 0;
	g_h9RallyLogWanted = want;
	g_h9RallyLogRec.valid = false;
	PM_Move(ppmove, server);
	g_h9RallyLogWanted = false;
	if (!want)
	{
		if (s_log.IsOpen() && h9_rally_log.value == 0)
			s_log.Close();
		return;
	}
	if (!g_h9RallyLogRec.valid)
		return; // not a car's command (a spectator, a dead player, a player on foot)

	// a new map load (another map, or the clock back to the start): a new file
	const char* map = STRING(gpGlobals->mapname);
	if (!s_log.IsOpen() || strncmp(map, s_logMap, sizeof s_logMap - 1) != 0 || gpGlobals->time + 1.0f < s_logLastTime)
	{
		if (!s_log.IsOpen() && s_log.capped && strncmp(map, s_logMap, sizeof s_logMap - 1) == 0 && gpGlobals->time + 1.0f >= s_logLastTime)
			return; // this map's file is full: no more of it
		char gameDir[260];
		GET_GAME_DIR(gameDir);
		snprintf(s_logMap, sizeof s_logMap, "%s", map);
		s_logSeq = 0;
		s_log.Open(gameDir, "srv", map, H9RALLYLOG_SRV_HEADER);
	}
	s_logLastTime = gpGlobals->time;
	if (!s_log.IsOpen())
		return;
	char line[1200];
	H9RallyLogFormatSrv(line, sizeof line, s_logSeq++, g_h9RallyLogRec);
	s_log.Line(line);
}

int H9RallyCvarClass()
{
	const int v = (int)h9_rally.value;
	return v < 0 ? 0 : (v > H9R_NUM_CARS ? H9R_NUM_CARS : v);
}

// What the server keeps of each player, by entity index: the car he chose, his money, his parts (h9_rally_shop_srv.h).
static RallyShop s_shop[33];
static int g_gmsgRallyMoney = 0, g_gmsgRallyParts = 0, g_gmsgRallyCar = 0;

static bool ValidIndex(int index)
{
	return index >= 1 && index <= 32;
}

// The class asked for, for this player: the cvar's (a server override that wins), else the car he chose, else the one a race map in
// rally mode (race_rules `vehicle "rally"`) gives, else off.
static int WantedClass(int index)
{
	return RallyEffectiveClass(H9RallyCvarClass(), RaceRallyClass(), ValidIndex(index) ? s_shop[index] : s_shop[0]);
}

int H9RallyClassOf(int index)
{
	return WantedClass(index);
}

bool H9RallyChosen(int index)
{
	return ValidIndex(index) && s_shop[index].chosen;
}

int H9RallyTopAdd(int index)
{
	return ValidIndex(index) ? RallyShopTopAdd(s_shop[index].parts) : 0;
}

void H9RallyLinkUserMessages()
{
	if (g_gmsgRallyMoney != 0)
		return;
	g_gmsgRallyMoney = REG_USER_MSG("H9RMoney", 4); // long: his money now
	g_gmsgRallyParts = REG_USER_MSG("H9RParts", 4); // long: bit p set = part p held
	g_gmsgRallyCar = REG_USER_MSG("H9RCar", 1);     // byte: his car class now, 0 none chosen
}

static void SendMoney(int index)
{
	if (g_gmsgRallyMoney == 0 || !ValidIndex(index))
		return;
	MESSAGE_BEGIN(MSG_ONE, g_gmsgRallyMoney, NULL, INDEXENT(index));
	WRITE_LONG(s_shop[index].money);
	MESSAGE_END();
}

static void SendParts(int index)
{
	if (g_gmsgRallyParts == 0 || !ValidIndex(index))
		return;
	MESSAGE_BEGIN(MSG_ONE, g_gmsgRallyParts, NULL, INDEXENT(index));
	WRITE_LONG((int)s_shop[index].parts);
	MESSAGE_END();
}

// His car now: the class he drives as when he has chosen one, else 0.
static void SendCar(int index)
{
	if (g_gmsgRallyCar == 0 || !ValidIndex(index))
		return;
	MESSAGE_BEGIN(MSG_ONE, g_gmsgRallyCar, NULL, INDEXENT(index));
	WRITE_BYTE(s_shop[index].chosen ? WantedClass(index) : 0);
	MESSAGE_END();
}

static void SendMenu(int index)
{
	MESSAGE_BEGIN(MSG_ONE, gmsgVGUIMenu, NULL, INDEXENT(index));
	WRITE_BYTE(5); // MENU_INTRO: in a rally race map the client turns it into the rally main menu
	MESSAGE_END();
}

void H9RallyShopJoin(int index)
{
	if (!ValidIndex(index))
		return;
	RallyShopJoin(s_shop[index]);
	RaceRallySitOut(index, false);
}

void H9RallyShopLeave(int index)
{
	if (!ValidIndex(index))
		return;
	s_shop[index] = RallyShop();
	RaceRallySitOut(index, false);
}

void H9RallyJoinMessages(CBasePlayer* pl)
{
	const int index = pl ? pl->entindex() : 0;
	if (!ValidIndex(index) || !RaceRallyMode())
		return;
	SendMoney(index);
	SendParts(index);
	SendCar(index);
	SendMenu(index);
}

static void AddMoney(int index, int amount)
{
	if (ValidIndex(index) && RallyShopAdd(s_shop[index], amount))
		SendMoney(index); // at every change (HL Rally's UpdateMoney was only at the finish: its figure lagged the checkpoints)
}

void H9RallyMoneyCheckpoint(int index)
{
	AddMoney(index, RallyMoneyCheckpoint(false));
}

void H9RallyMoneyFinish(int index, int place)
{
	AddMoney(index, RallyMoneyFinish(place));
}

void H9RallyLeaveObserver(CBasePlayer* pl)
{
	pl->m_flTSRespawnTime = 0.0f; // TS's gate (a joiner's 5 s, a death's wait) does not hold a car that has been chosen
	pl->StopObserver();
}

// A decimal number and nothing else.
static bool ParseInt(const char* s, int& out)
{
	if (!s || !*s)
		return false;
	for (const char* c = s; *c; c++)
		if (*c < '0' || *c > '9')
			return false;
	out = atoi(s);
	return true;
}

// A car was chosen: HL Rally's three cases (client.cpp:872-892). No race running: the car is there now, on its slot. A race running: a
// racer who has not finished and has not used selectcar joins from lap 0 (mp_joinmidrace), any other is an observer until the next race.
// A player who was an observer is made alive by TS's own spawn (StopObserver -> respawn) and the race seats him on his slot on its next frame.
static void ApplyChoice(CBasePlayer* pl)
{
	const int index = pl->entindex();
	const int rule = RallyJoinRuleFor(RaceRallyRunning(), RaceRallyDone(pl) || RaceRallySittingOut(index), RaceRallyJoinMidRace());
	if (rule == RALLY_JOIN_OUT)
	{
		if (!pl->IsObserver())
			pl->TSEnterSpectate(false);
		RaceRallySitOut(index, true);
		return;
	}
	if (pl->IsObserver())
		H9RallyLeaveObserver(pl);
	else
		RaceRallyPutOnSlot(pl);
}

bool H9RallyCommand(CBasePlayer* pl, const char* cmd)
{
	if (!pl || !cmd || !RaceRallyMode())
		return false;
	const int index = pl->entindex();
	if (!ValidIndex(index))
		return false;
	const bool isChange = FStrEq(cmd, "changecar"), isSpectate = FStrEq(cmd, "spectate"), isSelect = FStrEq(cmd, "selectcar"),
			   isBuy = FStrEq(cmd, "buy");
	if (!isChange && !isSpectate && !isSelect && !isBuy)
		return false;
	RallyShop& shop = s_shop[index];

	if (isChange)
	{
		// HL Rally: an unknown car is ignored (client.cpp:850-851); the money stays, the parts go (:866-867)
		int cls = 0;
		if (CMD_ARGC() < 2 || !ParseInt(CMD_ARGV(1), cls) || !RallyShopChange(shop, cls))
			return true;
		SendCar(index);
		SendParts(index);
		ApplyChoice(pl);
	}
	else if (isSpectate)
	{
		// HL Rally (client.cpp:896-908): an observer, and `fuser1 = 0` so that he is out of the next race. allow_spectators is not
		// added: TS has no such cvar and the audit leaves it to the owner; spectating is allowed.
		shop.chosen = false;
		if (!pl->IsObserver())
			pl->TSEnterSpectate(false);
		SendCar(index);
	}
	else if (isSelect)
	{
		// HL Rally (client.cpp:716-723): only while a race runs; `fuser1 = 0`, observer, the main menu, and "don't let them join this race again"
		if (!RaceRallyRunning())
			return true;
		shop.chosen = false;
		if (!pl->IsObserver())
			pl->TSEnterSpectate(false);
		RaceRallySitOut(index, true);
		SendCar(index);
		SendMenu(index);
	}
	else
	{
		int part = 0;
		if (CMD_ARGC() < 2 || !ParseInt(CMD_ARGV(1), part))
			return true;
		if (RallyShopBuy(shop, part) == 0)
		{
			SendMoney(index); // the client's own subtraction is not copied: the server says what he has
			SendParts(index);
		}
	}
	return true;
}

bool H9RallyRespawnRefused(CBasePlayer* pl)
{
	if (!pl || !RaceRallyMode() || pl->pev->iuser1 == 0)
		return false;
	const int index = pl->entindex();
	if (!ValidIndex(index))
		return false;
	if (!s_shop[index].chosen)
	{
		// HL Rally: a player who has not chosen stays an observer, and Enter opens the main menu (S:cl_dll/vgui_TeamFortressViewport.cpp:2077-2095)
		SendMenu(index);
		return true;
	}
	if (RaceRallySittingOut(index))
	{
		if (gpGlobals->time > pl->m_flSpecMsgTime)
		{
			pl->m_flSpecMsgTime = gpGlobals->time + 1.0f;
			TSHudMessageOne(195, 45, 45, 16, 20, "You have to wait until the next round.", pl->pev);
		}
		return true;
	}
	return false;
}

// A number in this player's physinfo (0 when the key is not there).
static int PhysInt(edict_t* ent, const char* key)
{
	char* info = (char*)g_engfuncs.pfnGetPhysicsInfoString(ent);
	const char* v = g_engfuncs.pfnInfoKeyValue(info, key);
	return v ? atoi(v) : 0;
}

// The class this player's physinfo says he is in.
static int CurrentClass(edict_t* ent)
{
	return PhysInt(ent, "rally");
}

bool H9RallyIsCar(edict_t* ent)
{
	return ent != nullptr && CurrentClass(ent) > 0;
}

void H9RallyClientData(const edict_t* ent, struct clientdata_s* cd)
{
	if (ent == nullptr || cd == nullptr || CurrentClass(const_cast<edict_t*>(ent)) <= 0)
		return;
	// HL Rally sends its tilt (vuser1) to nobody: the client's prediction starts each run from no tilt and looks for the ground
	// straight down; only the server's chain keeps the tilt from command to command. Sending ours made the client's chain
	// carry it on, and a car near a bank tipped further each frame (the owner: "tiende a quedar de costado", 2026-11-14).
	cd->vuser3.x = 0; // no mark: H9RallyTiltUnpack fails and the command starts flat (pm_shared/h9_rally.cpp)
	cd->vuser4 = Vector(0, 0, 0);
}

// A number in this player's physinfo, set when it differs.
static void SetPhysInt(edict_t* ent, const char* key, int value)
{
	if (PhysInt(ent, key) == value)
		return;
	char buf[16];
	snprintf(buf, sizeof buf, "%d", value);
	g_engfuncs.pfnSetPhysicsKeyValue(ent, key, buf);
}

void H9RallyServerThink(CBasePlayer* pl)
{
	const int want = WantedClass(pl->entindex());
	const int cur = CurrentClass(pl->edict());
	ApplyMovevars(want > 0);

	if (want == cur && want == 0)
	{
		H9RallySoundStop(pl); // cheap when nothing plays
		return;
	}

	entvars_t* pev = pl->pev;
	if (want != cur)
	{
		char buf[8];
		snprintf(buf, sizeof buf, "%d", want);
		g_engfuncs.pfnSetPhysicsKeyValue(pl->edict(), "rally", buf);
		if (cur == 0 && want != 0)
		{
			pev->flags &= ~FL_DUCKING;
			pev->velocity = Vector(0, 0, 0);
			pev->friction = 1.0f; // a stunt's friction stays on a player in multiplayer, and the car's pull is x friction
		}
		else if (want == 0)
		{
			// out of the car: the standing hull's origin is 36 above the floor the car's origin was on
			UTIL_SetSize(pev, VEC_HULL_MIN, VEC_HULL_MAX);
			UTIL_SetOrigin(pev, pev->origin + Vector(0, 0, 36));
			pev->view_ofs = VEC_VIEW;
			pev->viewmodel = 0; // the interior's model is not a weapon's
			pl->SetPlayerSpeed(GetSpeedBySlots(pl)); // the loadout's speed again (a car's maxspeed is 3000)
			H9RallySoundStop(pl); // the mode went off (the cvar to 0, or the race's vehicle changed): no loop is left
			return;
		}
	}

	// the parts' stat additions, for pmove on both sides (pm_shared/h9_rally.cpp adds them to the car's handling and top speed)
	{
		const int idx = pl->entindex();
		const unsigned parts = ValidIndex(idx) ? s_shop[idx].parts : 0;
		SetPhysInt(pl->edict(), "rh", RallyShopHandlingAdd(parts));
		SetPhysInt(pl->edict(), "rt", RallyShopTopAdd(parts));
		// the hull: BSP hull 1 (usehull 0) on a map made for HL Rally's cars, the point hull of the map's own shape elsewhere
		// (pm_shared/h9_rally.cpp, top): the map's own key, not the cvar that forces rally on any map
		SetPhysInt(pl->edict(), "rhull", RaceRallyMapKey() ? 1 : 0);
	}

	// the headlights: HL Rally's flashlight impulse (100; its player.cpp:3565-3595 tells every client), read here before
	// ImpulseCommands clears it
	{
		static bool s_lights[33];
		const int idx = pl->entindex();
		if (pev->impulse == 100 && idx >= 1 && idx <= 32 && gmsgRallyLight != 0)
		{
			s_lights[idx] = !s_lights[idx];
			MESSAGE_BEGIN(MSG_ALL, gmsgRallyLight);
			WRITE_BYTE(idx);
			WRITE_BYTE(s_lights[idx] ? 1 : 0);
			MESSAGE_END();
		}
	}

	// the debug line's switch
	const int wantDebug = h9_rally_debug.value != 0 ? 1 : 0;
	if (PhysInt(pl->edict(), "rdbg") != wantDebug)
		g_engfuncs.pfnSetPhysicsKeyValue(pl->edict(), "rdbg", wantDebug ? "1" : "0");

	// the finish: the client's brake-then-coast of a car that has crossed the line is pmove's, from this key
	const int wantFin = RaceFinishedCar(pl) ? 1 : 0;
	if (PhysInt(pl->edict(), "rfin") != wantFin)
		g_engfuncs.pfnSetPhysicsKeyValue(pl->edict(), "rfin", wantFin ? "1" : "0");

	// nothing of the loadout holds a car: a sane maxspeed for pev and for the client's prediction (a player with every item
	// gone can be left with 0, and TS only sets it on loadout events). The slow motion's factor (fuser1) is ignored by pmove.
	if (pev->maxspeed != H9RALLY_MAXSPEED)
	{
		pev->maxspeed = H9RALLY_MAXSPEED;
		g_engfuncs.pfnSetClientMaxspeed(pl->edict(), H9RALLY_MAXSPEED);
	}

	// in the car: no weapons, and the car's size for whatever else in the world touches the player
	if (pl->m_pActiveItem)
		pl->RemoveAllItems(false);
	// the view model slot holds the interior (a wheel, a speedometer and a rev counter drawn by the client) when its file is there, else nothing
	{
		const char* interior = H9RallyInteriorModel();
		pev->viewmodel = interior != nullptr ? MAKE_STRING(interior) : 0;
	}
	pev->weaponmodel = 0;
	if (pev->maxs.z != 1.0f || pev->maxs.x != 5.0f || pev->mins.z != -1.0f)
		UTIL_SetSize(pev, Vector(-5, -5, -1), Vector(5, 5, 1)); // HL Rally's: VEC_HULL_MIN/MAX of its util.h

	// his sounds: the engine by gear, skids, landings, walls, the horn (h9_rally_snd.cpp)
	H9RallySoundThink(pl, want);
}
