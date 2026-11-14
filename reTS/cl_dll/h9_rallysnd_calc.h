// H9 rally mode's sounds on the client, the arithmetic alone (no engine call, no engine type), so cl_dll/tests/rallysnd_test.cpp can run it.
// cl_dll/h9_rallysnd.cpp feeds it the client's own revs and plays what it says through the engine.
//
// What this is. HL Rally plays every car sound on the CLIENT, each frame, through FMOD 3 (cl_dll/rally_sound.cpp, Rally_Effects.cpp). The numbers
// below are facts about that game's behaviour, read from its source; the code and every comment are ours. Each function names the HL Rally
// file and line its rule comes from ("rs" is cl_dll/rally_sound.cpp, "re" is cl_dll/Rally_Effects.cpp, "in" is cl_dll/input.cpp, "hud" is
// cl_dll/rallyhud.cpp).
//
// FMOD's scale and ours. HL Rally sets a channel's volume on FMOD's 0..255 scale as (a number) x the game's `volume` cvar, and its pitch as a
// frequency in Hz. The engine here takes a volume 0..1 (and multiplies by its own `volume`) and a pitch in percent of the file's own speed
// (100 is as recorded; Xash3D's client API takes any whole number from 2 up). So volume = FMOD number / 255, pitch = Hz x 100 / the file's rate.
//
// The arguments HL Rally passes are WHOLE numbers where it says `int rpm`: rpm / 2 and rpm / 3 are integer divisions, and the frequency is an int.
// The functions below take the int the same way.
#pragma once

#include <math.h>
#include <stddef.h>
#include <string.h>

namespace rallysnd
{

const float kFmodMax = 255.0f;           // FMOD's volume scale
const float kOneShotVol = 200.0f / 255.0f; // rs fmodPlay/fmodPlay3D: volume * vol * VOL_MULT (200), so a one-shot of vol 1 is 200/255 of full
const int kMinPitch = 2;                 // Xash3D S_StartSound: a pitch of 1 or less is taken as 100, so 2 is the lowest that is itself

inline float Clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ---- the local car's engine -----------------------------------------------------------------------------------------------------------------

// rs:333 FSOUND_SetFrequency(chan, 2000 + rpm*260)
inline int LocalHz(int rpm) { return 2000 + rpm * 260; }

// rs:323-331. `accelerating` is g_accelerating as renderCalculateRPMs left it (re:373-376): 2 when the revs fell by more than 2 since the last frame,
// else 0. Over 0 the louder line, 40 + rpm / 2, else 20 + rpm / 3 (integer divisions); capped at 255. On FMOD's scale (times the volume cvar there).
inline float LocalVolumeFmod(int rpm, int accelerating)
{
	float v = accelerating > 0 ? (float)(40 + rpm / 2) : (float)(20 + rpm / 3);
	return v > 255.0f ? 255.0f : v;
}

// re:373-376: the flag the sounds read. The revs of this frame against the last frame's.
inline int Accelerating(float oldRpm, float rpm) { return oldRpm > (rpm + 2.0f) ? 2 : 0; }

// ---- the second layer, the racing whine -----------------------------------------------------------------------------------------------------

// rs:337-347. speed3 is Length(vel), the car's velocity (all three axes), units a second. Under 500 the plain (10 + rpm / 3); from 500 that times
// (1500 - 2 speed) / 600 (1 at 500, 0 at 750), never under 0.
inline float WhineVolumeFmod(int rpm, float speed3)
{
	const float base = (float)(10 + rpm / 3);
	if (speed3 < 500.0f)
		return base;
	float t = base * (((-speed3 * 2.0f) + 1500.0f) / 600.0f);
	return t < 0.0f ? 0.0f : t;
}

// rs:349 FSOUND_SetFrequency(whine, 4000 + rpm*30 + (Length(vel) * 80)): a float into an int parameter, so truncated.
inline int WhineHz(int rpm, float speed3) { return (int)(4000 + rpm * 30 + (speed3 * 80)); }

// ---- the other cars' engines ----------------------------------------------------------------------------------------------------------------

// rs:543-551 (fmodPlayRemoteEngines): volume 25 + rpm / 4 capped at 75; frequency 2000 + rpm * 220.
inline float RemoteVolumeFmod(int rpm)
{
	const float v = (float)(25 + rpm / 4);
	return v > 75.0f ? 75.0f : v;
}
inline int RemoteHz(int rpm) { return 2000 + rpm * 220; }

// re:1672-1709 (renderPlayerSounds, a car that is not the local one): the revs are guessed from its ground speed (units a second, from its position
// history). `state` is what HL Rally keeps in the entity's baseline.origin[0] (the smoothed revs, 0 until the first frame). `countdown` is the race's
// countdown mode. The two random numbers are the ones HL Rally draws when it needs them (400..1100 and 0..150), given so a test can fix them.
// Returns the revs (a float; the sound takes its integer part).
inline float RemoteRevs(float& state, float speed2D, bool countdown, float frametime, float rand400to1100, float rand0to150)
{
	const float cs = speed2D * 1.25f;
	const int gear = (int)(cs / 250.0f) + 1;
	float revs = cs / (float)gear;
	if (speed2D > 2.0f)
	{
		// (HL Rally clamps `gear` to 1..6 here, after the revs were taken from it: no effect on them)
	}
	else if (countdown)
		revs = state + (rand400to1100 * frametime);
	else
		revs = 15.0f;
	if (revs < 10.0f)
		revs = 15.0f;
	else if (revs > 250.0f)
	{
		state = 250.0f;
		revs = 100.0f + rand0to150;
	}
	revs = ((state * 3.0f) + revs) / 4.0f;
	state = revs;
	return revs;
}

// rs:461-516 (fmodAddRemoteEngine), 518-559: only the `cap` (rally_sound_3dchannels, 4) NEAREST cars to the local car are heard. Cars are offered one at a
// time; while there is room they are slotted in, then one that is nearer than the farthest held replaces it. The result is the `cap` nearest of
// all that were offered, whatever the order; the slots keep the place they were given (the farthest's), as HL Rally's do.
const int kMaxSlots = 32;
struct Slots
{
	int n;
	int car[kMaxSlots];
	float dist[kMaxSlots];
	float maxDist;
};
inline void SlotsReset(Slots& s)
{
	s.n = 0;
	s.maxDist = 8196.0f; // rs: f3dSoundMaxDist = 8196 after every frame
}
inline void SlotsMax(Slots& s)
{
	s.maxDist = 0.0f;
	for (int i = 0; i < s.n; i++)
		if (s.dist[i] > s.maxDist)
			s.maxDist = s.dist[i];
}
inline void SlotsOffer(Slots& s, int cap, int car, float dist)
{
	if (cap > kMaxSlots)
		cap = kMaxSlots;
	if (cap < 1)
		return;
	if (s.n < cap)
	{
		s.car[s.n] = car;
		s.dist[s.n] = dist;
		s.n++;
		SlotsMax(s);
	}
	else if (dist < s.maxDist)
	{
		for (int i = 0; i < cap; i++)
		{
			if (s.dist[i] == s.maxDist)
			{
				s.car[i] = car;
				s.dist[i] = dist;
				break;
			}
		}
		SlotsMax(s);
	}
}

// ---- tyre squeal ----------------------------------------------------------------------------------------------------------------------------

// re:1114-1142: the texture under the car says what a skid mark is and whether it squeals. noskid: no mark and no sound (the function returns);
// roadgras, dirt, gras, mud, soil, 3dmroad: dirt marks; sand, desert: sand; snow: snow; anything else: the plain mark, and only then the sound.
enum SkidSurface
{
	SKID_NONE = 0, // noskid
	SKID_DIRT,
	SKID_SAND,
	SKID_SNOW,
	SKID_TARMAC // the only one HL Rally squeals on
};
inline bool HasWord(const char* low, const char* word) { return strstr(low, word) != NULL; }
inline int SkidSurfaceOf(const char* texture)
{
	char low[64];
	size_t i = 0;
	for (; texture[i] && i < sizeof(low) - 1; i++)
		low[i] = (texture[i] >= 'A' && texture[i] <= 'Z') ? (char)(texture[i] + 32) : texture[i];
	low[i] = 0;
	if (HasWord(low, "noskid"))
		return SKID_NONE;
	if (HasWord(low, "roadgras") || HasWord(low, "dirt") || HasWord(low, "gras") || HasWord(low, "mud") || HasWord(low, "soil") || HasWord(low, "3dmroad"))
		return SKID_DIRT;
	if (HasWord(low, "sand") || HasWord(low, "desert"))
		return SKID_SAND;
	if (HasWord(low, "snow"))
		return SKID_SNOW;
	return SKID_TARMAC;
}

// re:1085-1112: the condition under which a mark is laid (and so a squeal may play), for the local car, once its back right corner has moved more
// than 15 units from the last mark's start (re:1029). `accelerating` is the flag of Accelerating() above, NOT the throttle: renderCalculateRPMs runs
// before renderPlayerCheckSkid in the same frame and overwrites it. `ty` is temp_vec[YAW], index 1: the Y component of (the velocity's direction
// less the nose's).
inline bool MarkGate(bool onGround, bool firstTime, int gear, float speed2D, int accelerating, bool braking, bool handbraking, bool tractionLoss, float ty,
	bool reversing)
{
	if (!(onGround && !firstTime && gear != 0))
		return false;
	// ((v > 25 && v < 200 && (acc || braking)) || (v > 25 && (hand || traction))) || ((ty > .45 || ty < -.45) && !reversing)
	if ((speed2D > 25.0f && speed2D < 200.0f && (accelerating != 0 || braking)) || (speed2D > 25.0f && (handbraking || tractionLoss)))
		return true;
	return (ty > 0.45f || ty < -0.45f) && !reversing;
}

// re:1132-1138: the squeal: a one-shot, at most once in 0.5 s, while a mark is being laid on the plain surface. `next` is SkidMarkSoundTime.
const float kSquealGap = 0.5f;
inline bool SquealStep(float& next, float now, float speed2D, float ty)
{
	if (next < now)
	{
		if (speed2D > 60.0f || ty > 0.15f || ty < -0.15f)
		{
			next = now + kSquealGap;
			return true;
		}
	}
	return false;
}

// ---- the backfire ---------------------------------------------------------------------------------------------------------------------------

// re:1537-1640 (renderPlayerExhaust) with g_backfire: the sound plays when the flag is raised and the last pop's window (0.15 s) is over; a flag
// raised inside the window only extends it. The flame (not ours) shows for the window, fading from 1 to 0.
const float kBackfireTime = 0.15f; // BACKFIRETIME
struct Backfire
{
	int g = 0;       // g_backfire: 0 none, 1 and 2 raised, -2 in its window
	float time = 0;  // m_fBackFireTime
};
// A raise: 2 on a downshift (re:304-305), 1 on the forward key while the revs were falling (in:893-896).
inline void BackfireRaise(Backfire& b, int kind) { b.g = kind; }
// in:893-896: the forward key is down, g_accelerating (the last frame's flag) is 2 and rpms (the last frame's) is over 140.
inline bool BackfireOnThrottle(bool forwardKey, int lastAccelerating, float lastRpm) { return forwardKey && lastAccelerating == 2 && lastRpm > 140.0f; }
// re:304-305 `if (old_gear > gear) g_backfire = 2;`
inline bool BackfireOnDownshift(int oldGear, int gear) { return oldGear > gear; }
// Once a frame: true when the sound is to be played now. `fade` gets the flame's fade (1..0), 0 when none.
inline bool BackfireFrame(Backfire& b, float now, float& fade)
{
	bool play = false;
	fade = 0.0f;
	if (b.g)
	{
		if (b.g != -2)
		{
			if (b.time < now)
				play = true;
			b.time = now + kBackfireTime;
			b.g = -2;
		}
		if (b.time > now)
			fade = (b.time - now) / kBackfireTime;
		else
			b.g = 0;
	}
	return play;
}

// ---- the wall ---------------------------------------------------------------------------------------------------------------------------------

// cl_dll/cdll_int.cpp:195-204 (HUD_PlayerMove): CL_CrashAmount is the velocity's part along the wall's normal (pm_shared/rally.c PM_Crash), set only
// for a plane with normal z under 0.3, and a hit of any nonzero amount plays: hitwall1 when it is over -100, else hitwall2, at 0.75, if the last one
// was more than 300 ms (pmove->time is in milliseconds) ago.
const float kHitVol = 0.75f;
const float kHitGapMs = 300.0f;
inline bool HitFile(float crashAmount) { return crashAmount > -100.0f; } // true: hitwall1, false: hitwall2
inline bool HitStep(float crashAmount, float& lastMs, float nowMs)
{
	if (crashAmount != 0.0f && lastMs < nowMs - kHitGapMs)
	{
		lastMs = nowMs;
		return true;
	}
	return false;
}

// ---- the voices -------------------------------------------------------------------------------------------------------------------------------

// hud:497-505: the sound at the player's own finish by his place (the first place under 2).
enum Finish
{
	FINISH_CONGRATS = 0,
	FINISH_SECOND,
	FINISH_THIRD,
	FINISH_NEXTTIME
};
inline int FinishVoice(int place)
{
	if (place < 2)
		return FINISH_CONGRATS;
	if (place < 3)
		return FINISH_SECOND;
	if (place < 4)
		return FINISH_THIRD;
	return FINISH_NEXTTIME;
}

// ---- what a sound file says about itself ------------------------------------------------------------------------------------------------------

// The sample rate of a file's bytes: a RIFF/WAVE (the fmt chunk) or an MPEG audio file (the first frame's header, after an ID3v2 tag). 0 when it is
// neither, or too short to say. The pitch of every file is its frequency over this rate, so a file whose rate is not known is not played.
inline unsigned ReadLe32(const unsigned char* p) { return (unsigned)p[0] | ((unsigned)p[1] << 8) | ((unsigned)p[2] << 16) | ((unsigned)p[3] << 24); }
inline unsigned ReadLe16(const unsigned char* p) { return (unsigned)p[0] | ((unsigned)p[1] << 8); }

// Walks a WAVE's chunks. `rate` gets the fmt chunk's rate (0 if none); returns whether a `cue ` chunk is there (Xash3D loops a wav only if it has one).
inline bool WavScan(const unsigned char* d, size_t n, int& rate, int& channels, int& bits)
{
	rate = channels = bits = 0;
	bool cue = false;
	if (n < 12 || memcmp(d, "RIFF", 4) != 0 || memcmp(d + 8, "WAVE", 4) != 0)
		return false;
	size_t i = 12;
	while (i + 8 <= n)
	{
		const unsigned sz = ReadLe32(d + i + 4);
		if (memcmp(d + i, "fmt ", 4) == 0 && i + 8 + 16 <= n)
		{
			channels = (int)ReadLe16(d + i + 10);
			rate = (int)ReadLe32(d + i + 12);
			bits = (int)ReadLe16(d + i + 22);
		}
		else if (memcmp(d + i, "cue ", 4) == 0)
			cue = true;
		i += 8 + (size_t)sz + (sz & 1u);
	}
	return cue;
}

inline int WavRate(const unsigned char* d, size_t n)
{
	int rate, ch, bits;
	WavScan(d, n, rate, ch, bits);
	return rate;
}

inline int Mp3Rate(const unsigned char* d, size_t n)
{
	size_t i = 0;
	if (n >= 10 && memcmp(d, "ID3", 3) == 0)
		i = 10 + (((size_t)(d[6] & 0x7f) << 21) | ((size_t)(d[7] & 0x7f) << 14) | ((size_t)(d[8] & 0x7f) << 7) | (size_t)(d[9] & 0x7f));
	static const int rates[3][3] = {{44100, 48000, 32000}, {22050, 24000, 16000}, {11025, 12000, 8000}}; // MPEG 1, 2, 2.5
	for (; i + 4 <= n && i < 65536; i++)
	{
		if (d[i] != 0xff || (d[i + 1] & 0xe0) != 0xe0)
			continue;
		const int version = (d[i + 1] >> 3) & 3; // 3 MPEG1, 2 MPEG2, 0 MPEG2.5, 1 reserved
		const int layer = (d[i + 1] >> 1) & 3;   // 1 layer III, 2 II, 3 I, 0 reserved
		const int rateIndex = (d[i + 2] >> 2) & 3;
		if (version == 1 || layer == 0 || rateIndex == 3)
			continue;
		const int row = version == 3 ? 0 : (version == 2 ? 1 : 2);
		return rates[row][rateIndex];
	}
	return 0;
}

inline int FileRate(const unsigned char* d, size_t n)
{
	int r = WavRate(d, n);
	return r > 0 ? r : Mp3Rate(d, n);
}

// ---- pitch ---------------------------------------------------------------------------------------------------------------------------------

// The engine's pitch (percent of the file's own speed) for a frequency in Hz that HL Rally gives FMOD for a file of `fileRate` Hz: the nearest whole
// percent (the engine's pitch is a whole number: at most half a percent of the file's rate is lost, 110 Hz on a 22050 Hz file), never under kMinPitch.
inline int PitchFor(int hz, int fileRate)
{
	if (fileRate <= 0)
		return 100;
	const int p = (int)((double)hz * 100.0 / (double)fileRate + 0.5);
	return p < kMinPitch ? kMinPitch : p;
}

// FMOD's 0..255 volume as the engine's 0..1 (the engine multiplies its own `volume`, as HL Rally multiplies the cvar).
inline float VolumeFor(float fmod) { return Clampf(fmod / kFmodMax, 0.0f, 1.0f); }

} // namespace rallysnd
