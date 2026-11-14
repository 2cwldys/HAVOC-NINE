// H9 rally mode's sounds on the client. See h9_rallysnd.h; the arithmetic is h9_rallysnd_calc.h.
//
// What plays here, and why on the client. HL Rally plays the engine of a car every frame from the client's own revs, through FMOD 3. The engine of this
// game (Xash3D) has no FMOD, but its client API plays a sound on a fixed channel and changes that channel's volume and pitch each frame
// (gEngfuncs.pEventAPI->EV_PlaySound with SND_CHANGE_VOL | SND_CHANGE_PITCH). That is what each loop below does: the call both starts the sound (if it is not
// playing: it is then started) and changes it (if it is). Nothing is told to the server, and the server plays no engine (the old server loop, whose pitch
// the server could change ten times a second and only up to 255 percent, is gone).
//
// The pitch. The engine's pitch is a whole number, percent of the file's own speed. On the client's API it is not limited above (the byte of the server's
// sound message is: 255), and 2 is the lowest that means itself (a pitch of 1 or less is taken as 100). HL Rally's frequency is 2000 + 260 rpm Hz for the
// local car, so the percent depends on the file's rate: the rate is read from each file's header (h9_rallysnd_calc.h, FileRate) the first time it is wanted.
//
// Where the files are. sound/h9/rally/ (the names are in the report; HL Rally's own are not copied here). A file that is not there plays nothing and says
// nothing; a file whose rate cannot be read is taken as absent. Nothing is precached (the client loads a sound when it first plays it).
//
// Looping. Xash3D loops a wav only if it has a `cue ` chunk, and an mp3 only with a LOOP_START tag. A loop file without one plays once to its end, and the
// next frame's call starts it again: heard as a loop with a tick at the seam.
#include "hud.h"
#include "cl_util.h"
#include "const.h"
#include "cl_entity.h"
#include "entity_state.h"
#include "event_api.h"
#include "pm_defs.h"
#include "pmtrace.h"
#include "race.h"

#include "h9_rallysnd.h"
#include "h9_rallysnd_calc.h"
#include "h9_rallycar.h"

#include <string.h>
#include <stdio.h>
#include <math.h>

#ifndef SND_STOP
#define SND_STOP (1 << 5)
#endif
#ifndef SND_CHANGE_VOL
#define SND_CHANGE_VOL (1 << 6)
#endif
#ifndef SND_CHANGE_PITCH
#define SND_CHANGE_PITCH (1 << 7)
#endif

using namespace rallysnd;

namespace
{

// ---- the files ----------------------------------------------------------------------------------------------------------------------------------

const char* const DIR = "h9/rally/"; // under sound/

struct Asset
{
	char name[96]; // under sound/, as the engine is asked for it
	int rate;      // the file's sample rate; 0: not on disk, or not understood
	float retryAt; // a missing file is looked for again after this (the client time)
	bool probed;
};
Asset s_assets[64];
int s_nAssets = 0;

void Probe(Asset& a, float now)
{
	a.probed = true;
	a.rate = 0;
	a.retryAt = now + 10.0f;
	char path[128];
	snprintf(path, sizeof(path), "sound/%s", a.name);
	int len = 0;
	byte* data = gEngfuncs.COM_LoadFile(path, 5, &len);
	if (!data)
		return;
	if (len > 0)
		a.rate = FileRate(data, (size_t)len);
	gEngfuncs.COM_FreeFile(data);
}

// The asset for sound/h9/rally/<rel>, or NULL when that file is not there.
const Asset* Find(const char* rel, float now)
{
	char name[96];
	snprintf(name, sizeof(name), "%s%s", DIR, rel);
	for (int i = 0; i < s_nAssets; i++)
	{
		Asset& a = s_assets[i];
		if (0 != strcmp(a.name, name))
			continue;
		if (a.rate == 0 && now >= a.retryAt)
			Probe(a, now);
		return a.rate > 0 ? &a : NULL;
	}
	if (s_nAssets >= (int)(sizeof(s_assets) / sizeof(s_assets[0])))
		return NULL;
	Asset& a = s_assets[s_nAssets++];
	memset(&a, 0, sizeof(a));
	snprintf(a.name, sizeof(a.name), "%s", name);
	Probe(a, now);
	return a.rate > 0 ? &a : NULL;
}

const Asset* FindFirst(const char* const* rels, int n, float now)
{
	for (int i = 0; i < n; i++)
		if (const Asset* a = Find(rels[i], now))
			return a;
	return NULL;
}

// ---- playing ------------------------------------------------------------------------------------------------------------------------------------

void Copy3(float* to, const float* from)
{
	to[0] = from[0];
	to[1] = from[1];
	to[2] = from[2];
}

// A loop on (ent, channel): started when it is not playing, its volume and pitch changed when it is.
void Loop(int ent, const float* org, int chan, const Asset* a, float vol, int pitch)
{
	float o[3];
	Copy3(o, org);
	gEngfuncs.pEventAPI->EV_PlaySound(ent, o, chan, a->name, vol, ATTN_NORM, SND_CHANGE_VOL | SND_CHANGE_PITCH, pitch);
}

void Stop(int ent, int chan, const Asset* a)
{
	if (a)
		gEngfuncs.pEventAPI->EV_StopSound(ent, chan, a->name);
}

// One shot on the car (ent); `vol` as the engine takes it (the caller has put HL Rally's 200/255 in it).
void Shot(int ent, const float* org, const Asset* a, float vol, float attn)
{
	if (!a)
		return;
	float o[3];
	Copy3(o, org);
	gEngfuncs.pEventAPI->EV_PlaySound(ent, o, CHAN_AUTO, a->name, vol, attn, 0, PITCH_NORM);
}

// ---- state --------------------------------------------------------------------------------------------------------------------------------------

cvar_t *s_cvCars, *s_cvSkid; // cl_h9_rallysnd_3dchannels (HL Rally's rally_sound_3dchannels, 4); cl_h9_racefx_marks (the marks' switch, HL Rally's rally_skid)
bool s_cvDone = false;
float s_lastTime = -1.0f;

// the race, from its messages
int s_raceState = -1;
bool s_muted = false; // fmodStopEngine: the local engine is silent from his finish to the next countdown

struct Local
{
	bool init;
	float rpm;       // the last frame's revs (HL Rally's oldrpms; the rpms the key handler reads)
	int acc;         // the last frame's g_accelerating
	int gear;
	bool engOn, whineOn;
	const Asset* eng;
	const Asset* whine;
	int engClass;
	Backfire bf;
	float fade;
	float squealNext;
	bool firstSkid;
	bool haveLast;
	float last0[3];
};
Local L;

struct Remote
{
	float state; // the revs HL Rally keeps in baseline.origin[0]
	bool playing;
	bool seen;
};
Remote R[33];
const Asset* s_remoteEng = NULL;
float s_crashMs = -1.0f;

void EnsureCvars()
{
	if (s_cvDone)
		return;
	if (!s_cvCars)
		s_cvCars = CVAR_CREATE("cl_h9_rallysnd_3dchannels", "4", FCVAR_ARCHIVE);
	if (!s_cvSkid) // the cvar h9_racefx.cpp makes, looked for until it is there
		s_cvSkid = gEngfuncs.pfnGetCvarPointer("cl_h9_racefx_marks");
	s_cvDone = s_cvCars && s_cvSkid;
}

void StopLocal(float now)
{
	if (L.engOn)
		Stop(gEngfuncs.GetLocalPlayer() ? gEngfuncs.GetLocalPlayer()->index : 0, CHAN_STATIC, L.eng);
	if (L.whineOn)
		Stop(gEngfuncs.GetLocalPlayer() ? gEngfuncs.GetLocalPlayer()->index : 0, CHAN_STATIC, L.whine);
	L.engOn = L.whineOn = false;
	(void)now;
}

const Asset* LocalEngineFile(int carClass, const char* carName, float now)
{
	char a[64], b[64];
	snprintf(a, sizeof(a), "engine/%s_engine.mp3", carName);
	snprintf(b, sizeof(b), "engine/%s_engine.wav", carName);
	const char* const rels[] = {a, b, "engine/206_engine.mp3", "engine/206_engine.wav"}; // rs fmodEngineStart: the model's .mp3, its .wav, then the 206
	(void)carClass;
	return FindFirst(rels, 4, now);
}

const char* CarName(int carClass)
{
	// pm_shared/h9_rally.h's g_h9RallyCars, the names HL Rally's models carry (carinfo.txt)
	switch (carClass)
	{
	case 2: return "accent";
	case 3: return "locust";
	default: return "xsara";
	}
}

void Voice(const char* const* rels, int n, float now)
{
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	if (!local)
		return;
	Shot(local->index, local->origin, FindFirst(rels, n, now), kOneShotVol, ATTN_NONE); // rs fmodPlay: 2D, volume * vol * 200
}

void VoiceOne(const char* rel, float now)
{
	Voice(&rel, 1, now);
}

// ---- the local car ------------------------------------------------------------------------------------------------------------------------------

void LocalFrame(float now, float dt, cl_entity_t* local)
{
	H9RallyDriveNote n;
	if (!H9RallyCar_DriveNote(n))
	{
		StopLocal(now);
		L.init = false;
		return;
	}
	if (!L.init)
	{
		memset(&L, 0, sizeof(L));
		L.init = true;
		L.rpm = n.rpm;
		L.gear = n.gear;
		L.firstSkid = true;
		L.squealNext = 0.0f;
	}

	// the flag the sounds read: the revs fell by more than 2 since the last frame (re:373-376)
	const int acc = Accelerating(L.rpm, n.rpm);

	// the backfire's triggers (in:893-896, re:304-305), then its pass (re:1546-1556)
	if (BackfireOnThrottle(n.throttle, L.acc, L.rpm))
		BackfireRaise(L.bf, 1);
	if (BackfireOnDownshift(L.gear, n.gear))
		BackfireRaise(L.bf, 2);
	float fade = 0.0f;
	if (BackfireFrame(L.bf, now, fade))
		Shot(local->index, local->origin, Find("backfire.wav", now), kOneShotVol, ATTN_NORM);
	L.fade = fade;

	L.rpm = n.rpm;
	L.acc = acc;
	L.gear = n.gear;

	// the engine and the whine, unless he has finished (rallyhud.cpp:530)
	if (s_muted)
		StopLocal(now);
	else
	{
		if (!L.eng || L.engClass != n.carClass)
		{
			if (L.engOn)
				Stop(local->index, CHAN_STATIC, L.eng);
			L.engOn = false;
			L.eng = LocalEngineFile(n.carClass, CarName(n.carClass), now);
			L.engClass = n.carClass;
		}
		if (!L.whine)
			L.whine = Find("engine/racing_whine.wav", now);
		const int rpm = (int)n.rpm; // the int parameter
		const float speed3 = n.valid ? sqrtf(n.vel[0] * n.vel[0] + n.vel[1] * n.vel[1] + n.vel[2] * n.vel[2]) : 0.0f;
		if (L.eng)
		{
			Loop(local->index, local->origin, CHAN_STATIC, L.eng, VolumeFor(LocalVolumeFmod(rpm, acc)), PitchFor(LocalHz(rpm), L.eng->rate));
			L.engOn = true;
		}
		if (L.whine)
		{
			Loop(local->index, local->origin, CHAN_STATIC, L.whine, VolumeFor(WhineVolumeFmod(rpm, speed3)), PitchFor(WhineHz(rpm, speed3), L.whine->rate));
			L.whineOn = true;
		}
	}

	// the squeal: while a mark is being laid on the plain surface (re:1007-1142)
	if (!n.valid || s_cvSkid == NULL || s_cvSkid->value == 0.0f)
		return;
	const float speed2D = sqrtf(n.vel[0] * n.vel[0] + n.vel[1] * n.vel[1]);
	if (speed2D < 20.0f)
		return;
	const float yaw = n.heading * (3.14159265f / 180.0f);
	const float fwd[3] = {cosf(yaw), sinf(yaw), 0.0f};
	const float right[3] = {sinf(yaw), -cosf(yaw), 0.0f};
	const float* o = local->origin;
	const float corner[3] = {o[0] + fwd[0] * -22.0f + right[0] * 12.0f, o[1] + fwd[1] * -22.0f + right[1] * 12.0f, o[2]}; // vCorners[BACK_RIGHT]
	const float dx = L.last0[0] - corner[0], dy = L.last0[1] - corner[1], dz = L.last0[2] - corner[2];
	if (!L.haveLast || sqrtf(dx * dx + dy * dy + dz * dz) > 15.0f || L.firstSkid)
	{
		// the mark's start: the corner moved 7 along the nose and 3 to the left, 3 up, and down to the ground (re:1050-1054)
		float start[3] = {corner[0] + fwd[0] * 7.0f - right[0] * 3.0f, corner[1] + fwd[1] * 7.0f - right[1] * 3.0f, corner[2] + 3.0f};
		float end[3] = {start[0], start[1], start[2] - 56.0f};
		pmtrace_t tr;
		gEngfuncs.pEventAPI->EV_SetUpPlayerPrediction(0, 1);
		gEngfuncs.pEventAPI->EV_PushPMStates();
		gEngfuncs.pEventAPI->EV_SetSolidPlayers(-1);
		gEngfuncs.pEventAPI->EV_SetTraceHull(2);
		gEngfuncs.pEventAPI->EV_PlayerTrace(start, end, PM_STUDIO_BOX, -1, &tr);
		gEngfuncs.pEventAPI->EV_PopPMStates();

		// temp_vec = the velocity's direction less the nose; its index 1 is the Y component (re:1042-1044)
		const float len3 = sqrtf(n.vel[0] * n.vel[0] + n.vel[1] * n.vel[1] + n.vel[2] * n.vel[2]);
		const float ty = (len3 > 1e-4f ? n.vel[1] / len3 : 0.0f) - fwd[1];
		const bool reversing = n.brake && !n.throttle && speed2D < 40.0f; // g_reversing (in:~930-962)
		const bool braking = n.brake && !reversing;                       // g_braking is cleared while reversing
		const bool gate = MarkGate(n.onGround, L.firstSkid, n.gear, speed2D, acc, braking, n.handbrake, n.tractionLoss > 0.0f, ty, reversing);
		if (gate)
		{
			float s0[3] = {o[0], o[1], o[2]};
			float s1[3] = {o[0], o[1], o[2] - 64.0f};
			const char* tex = gEngfuncs.pEventAPI->EV_TraceTexture(0, s0, s1);
			if (tex)
			{
				const int surface = SkidSurfaceOf(tex);
				if (surface == SKID_NONE)
					return; // noskid: HL Rally leaves the function here, the mark's start is not kept
				if (surface == SKID_TARMAC && SquealStep(L.squealNext, now, speed2D, ty))
					Shot(local->index, local->origin, Find("skid_tarmac.wav", now), kOneShotVol, ATTN_NORM);
			}
		}
		else
			L.firstSkid = false;
		L.last0[0] = tr.endpos[0];
		L.last0[1] = tr.endpos[1];
		L.last0[2] = tr.endpos[2];
		L.haveLast = true;
	}
	(void)dt;
}

// ---- the other cars -----------------------------------------------------------------------------------------------------------------------------

void RemoteFrame(float now, float dt, cl_entity_t* local)
{
	Slots slots;
	SlotsReset(slots);
	const bool countdown = s_raceState == RACE_COUNTDOWN;
	int cap = s_cvCars ? (int)s_cvCars->value : 4;
	if (cap > kMaxSlots)
		cap = kMaxSlots;
	int maxc = gEngfuncs.GetMaxClients();
	if (maxc > 32)
		maxc = 32;
	int rpms[33];
	memset(rpms, 0, sizeof(rpms));
	for (int i = 1; i <= maxc; i++)
		R[i].seen = false;

	for (int i = 1; i <= maxc; i++)
	{
		cl_entity_t* ent = gEngfuncs.GetEntityByIndex(i);
		if (!ent || ent->index == local->index || !ent->player || !H9RallyCar_IsCarEntity(ent))
			continue;
		if (ent->curstate.messagenum < local->curstate.messagenum)
			continue; // not in this frame's update: not drawn
		// its velocity from its position history (re:511-533): the last two updates' origins over their animtimes
		const int cp = ent->current_position & HISTORY_MASK;
		const int pp = cp == 0 ? HISTORY_MAX - 1 : cp - 1;
		const float at = ent->ph[cp].animtime - ent->ph[pp].animtime;
		float vx, vy;
		if (at > 1e-4f)
		{
			vx = (ent->ph[cp].origin[0] - ent->ph[pp].origin[0]) / at;
			vy = (ent->ph[cp].origin[1] - ent->ph[pp].origin[1]) / at;
		}
		else // HL Rally divides by zero here; the state's own velocity stands in
		{
			vx = ent->curstate.velocity[0];
			vy = ent->curstate.velocity[1];
		}
		const float speed2D = sqrtf(vx * vx + vy * vy);
		const float revs = RemoteRevs(R[i].state, speed2D, countdown, dt, gEngfuncs.pfnRandomFloat(400.0f, 1100.0f), gEngfuncs.pfnRandomFloat(0.0f, 150.0f));
		rpms[i] = (int)revs;
		R[i].seen = true;
		const float ox = ent->origin[0] - local->origin[0], oy = ent->origin[1] - local->origin[1], oz = ent->origin[2] - local->origin[2];
		SlotsOffer(slots, cap, i, sqrtf(ox * ox + oy * oy + oz * oz));
	}

	if (!s_remoteEng)
	{
		const char* const rels[] = {"engine/206_engine.mp3", "engine/206_engine.wav"}; // every other car sounds like the 206
		s_remoteEng = FindFirst(rels, 2, now);
	}
	bool inSlot[33];
	memset(inSlot, 0, sizeof(inSlot));
	if (s_remoteEng)
	{
		for (int k = 0; k < slots.n; k++)
		{
			const int i = slots.car[k];
			cl_entity_t* ent = gEngfuncs.GetEntityByIndex(i);
			if (!ent)
				continue;
			inSlot[i] = true;
			Loop(i, ent->origin, CHAN_STATIC, s_remoteEng, VolumeFor(RemoteVolumeFmod(rpms[i])), PitchFor(RemoteHz(rpms[i]), s_remoteEng->rate));
			R[i].playing = true;
		}
	}
	for (int i = 1; i <= maxc; i++)
	{
		if (R[i].playing && !inSlot[i])
		{
			Stop(i, CHAN_STATIC, s_remoteEng);
			R[i].playing = false;
		}
	}
}

} // namespace

void H9RallySnd_Frame()
{
	if (!gEngfuncs.pEventAPI)
		return;
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	if (!local)
		return;
	EnsureCvars();
	const float now = gEngfuncs.GetClientTime();
	float dt = now - s_lastTime;
	s_lastTime = now;
	if (dt <= 0.0f)
		return; // paused, or the clock began again
	if (dt > 0.25f)
		dt = 0.25f;
	LocalFrame(now, dt, local);
	RemoteFrame(now, dt, local);
}

void H9RallySnd_RaceState(int state, float greenAt, float serverNow, float countdown)
{
	const int prev = s_raceState;
	s_raceState = state;
	if (state == prev || !H9RallyCam_LocalIsCar()) // the voices are rally mode's: another race has its beeps from the server
		return;
	const float now = gEngfuncs.GetClientTime();
	const float left = greenAt - serverNow;
	if (state == RACE_COUNTDOWN)
	{
		s_muted = false; // rallyhud.cpp:207 fmodStartEngine
		// hud:185: the voice at the countdown's start (a state met mid-countdown, as by a player who has just joined, does not start it)
		if (left >= countdown - 1.0f)
			VoiceOne("voc/321.wav", now);
	}
	else if (state == RACE_FINISHED)
	{
		// hud:488-490: the first finisher starts the others' 30 seconds, and everyone hears the warning (only where our clock is 30 s too)
		if (left >= 29.0f && left <= 31.0f)
			VoiceOne("voc/warning30.wav", now);
	}
}

void H9RallySnd_RaceNote(int kind, int a, int b)
{
	if (!H9RallyCam_LocalIsCar())
		return;
	const float now = gEngfuncs.GetClientTime();
	(void)b;
	switch (kind)
	{
	case RACE_NOTE_CHECKPOINT: // hud:381
		VoiceOne("voc/checkpoint.wav", now);
		break;
	case RACE_NOTE_LAP: // hud:420
		VoiceOne("voc/lapend.wav", now);
		break;
	case RACE_NOTE_FINISH: // hud:497-505, then 530: the engine is muted
	{
		static const char* const congrats[] = {"voc/congrats.wav", "voc/congrats.mp3"};
		static const char* const second[] = {"voc/second.wav", "voc/second.mp3"};
		static const char* const third[] = {"voc/third.wav", "voc/third.mp3"};
		static const char* const next[] = {"voc/nexttime.wav"};
		switch (FinishVoice(a))
		{
		case FINISH_CONGRATS: Voice(congrats, 2, now); break;
		case FINISH_SECOND: Voice(second, 2, now); break;
		case FINISH_THIRD: Voice(third, 2, now); break;
		default: Voice(next, 1, now); break;
		}
		s_muted = true;
		break;
	}
	default:
		break;
	}
}

void H9RallySnd_Crash(float crashAmount, float pmTimeMs, const float origin[3])
{
	if (!HitStep(crashAmount, s_crashMs, pmTimeMs))
		return;
	cl_entity_t* local = gEngfuncs.GetLocalPlayer();
	if (!local || !gEngfuncs.pEventAPI)
		return;
	const float now = gEngfuncs.GetClientTime();
	Shot(local->index, origin, Find(HitFile(crashAmount) ? "hitwall1.wav" : "hitwall2.wav", now), kHitVol * kOneShotVol, ATTN_NORM);
}

float H9RallySnd_BackfireFade()
{
	return L.fade;
}
