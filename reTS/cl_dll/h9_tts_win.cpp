// ---- H9 text to speech on Windows -------------------------------------------------------------------------------
// A line is rendered to memory by SAPI, shaped, and played through waveOut:
//
//   voice    SAPI voice by gender: the best installed one (a Natural or Neural voice ahead of a plain one, US then UK
//            English ahead of other languages), the man's, the woman's; a speaker who asked for a variant gets the n-th
//            of the voices of his kind, and a player's own pick (cl_h9_tts_voice_*) overrides both. A Mech is the man's
//            voice slower and lower, a bot the man's faster and higher (the samples resampled to 0.80 and 1.22 times
//            their speed, which moves tempo and pitch together)
//   depth    the speaker's depth (his cl_h9_tts_mydepth, and a step off his slot's): the samples resampled the same way,
//            1.025 times faster and higher for each step up
//   muffled  a gas mask: a fourth-order low-pass at 1800 Hz / (1 + cl_h9_tts_muffle), a resonant bump at 700 Hz, then
//            the line brought back to 85% of the loudness it had, so the mask is heard as dullness and not as distance
//   volume   the distance volume (and cl_h9_tts_volume) multiplied into the samples
//   pan      the speaker's direction, from the server: a constant-power pan into the ears, stereo from here on
//
// All of it runs on one worker thread of its own, with its own COM apartment, so the render thread only ever queues a
// line and never waits for a voice. A speaker has one line at a time: his new line stops his older one, queued or
// playing. At most cl_h9_tts_maxvoices voices play together (kSlots at the most); a line louder than the quietest
// one playing takes its place, a quieter one is not spoken.
//
// The text is spoken with SPF_IS_NOT_XML, so nothing a player types can be taken for SAPI markup (an <audio> or a
// <voice> tag). Nothing from the client's headers is used here, and the wave-format GUID is defined below instead of
// linking sapi.lib, so client.dll has no load-time dependency on sapi.dll: a machine without SAPI still loads it,
// and H9TtsPlat_Available() is false there.

#if defined(_WIN32) && !defined(__EMSCRIPTEN__)

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#include <sapi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "h9_tts_platform.h"

namespace
{
const int kRate = 22050;                // the rate SAPI renders at
const int kSlots = 3;                   // voices playing together
const int kQueue = 8;                   // lines waiting for the worker
const int kTextBytes = H9TTS_TEXT_MAX + 1;
const int kMaxBytes = kRate * 2 * 30;   // a line is cut to 30 seconds
const double kMaskHz = 1800.0;          // the gas mask's low-pass is kMaskHz / (1 + strength): 900 Hz at the standard strength
const double kMaskQ = 0.7071;           // two of them in a row, a fourth-order Butterworth
const double kMaskPeakHz = 700.0;       // and the boxy resonance of a face inside a mask
const double kMaskPeakQ = 1.2;
const double kMaskPeakDb = 4.0;         // for each unit of strength
const double kMaskMatch = 0.85;         // the muffled line's loudness (RMS) as a fraction of the clear line's
const double kDepthStep = 1.025;        // the speed and pitch for each step of a speaker's depth
const double kPanRange = 0.85;          // how far into one ear a voice goes (1 would be all the way)
const double kPanGain = 1.2;            // and what a constant-power pan is brought back up by, so a centred voice is not quieter than a mono one was
const double kRobotDepth = 0.65;        // how much of a robot's line is its ring-modulated self
const double kRobotMechHz = 38.0;       // the hum it is modulated with: a Mech's, lower
const double kRobotBotHz = 62.0;        // and a bot's
const int kMaxVoices = 24;              // voices listed for a player's pick
const double kHeadroom = 0.6;           // SAPI renders close to full scale: a volume of 1 leaves 4 dB of headroom

// SPDFID_WaveFormatEx, the id of a WAVEFORMATEX stream. sapi.h declares it and sapi.lib defines it.
const GUID kWaveFormatEx = { 0xC31ADBAE, 0x527F, 0x4FF5, { 0xA2, 0x30, 0xF6, 0x2B, 0xB6, 0x1F, 0xF7, 0x0C } };

struct Job
{
	int speaker;
	int voice;
	bool muffled;
	bool robot;
	int choice;
	int variant;
	int depth;
	int maxVoices;
	float muffle;
	float pan;
	float volume;
	char text[kTextBytes];
};

struct Slot
{
	HWAVEOUT hwo;
	WAVEHDR hdr;
	short* pcm;
	int speaker; // 0 while the slot is free
	float level; // the volume the line was started at: the quietest voice is the one a louder line takes the place of
	DWORD started;
};

// Shared with the render thread, under s_mtx.
std::mutex s_mtx;
std::condition_variable s_cv;
std::thread* s_pThread = nullptr;
bool s_bQuit = false;
Job s_queue[kQueue];
int s_iQueued = 0;
bool s_bPurge[256]; // a speaker whose playing line is to stop
std::atomic<bool> s_bBroken(false); // set by the worker once it knows there is no SAPI voice to be had

// The worker's own.
Slot s_slots[kSlots];
ISpVoice* s_pVoice[2] = { nullptr, nullptr }; // the man's, the woman's
bool s_bVoiceTried[2] = { false, false };
bool s_bWomanIsMan = false;                   // no female voice is installed: the woman is the man's, higher

// The voices SAPI has installed, listed once by the worker; a player's cl_h9_tts_voice_* is a place in this list, from 1.
struct VoiceEntry
{
	char name[96];
	char gender; // 'M', 'F' or '?'
	bool english;
	int score;   // how good a default the voice is: higher is better (see ScoreVoice)
	ISpObjectToken* token;
};
VoiceEntry s_voices[kMaxVoices];
std::atomic<int> s_nVoices(0);                // set once the list is complete
ISpVoice* s_pTokenVoice[kMaxVoices];          // the voices made for a player's pick, by place in the list
int s_iDefault[2] = { -2, -2 };               // the man's and the woman's default voice: a place in the list (from 0), -1 none, -2 not looked for yet

// ---- SAPI -------------------------------------------------------------------------------------------------------

// The first installed voice with this gender, English (US, then UK) ahead of any other; null when there is none.
ISpObjectToken* FindToken(const wchar_t* gender)
{
	ISpObjectTokenCategory* category = nullptr;
	if (FAILED(CoCreateInstance(__uuidof(SpObjectTokenCategory), nullptr, CLSCTX_ALL, __uuidof(ISpObjectTokenCategory), (void**)&category))
		|| !category)
		return nullptr;

	ISpObjectToken* found = nullptr;
	if (SUCCEEDED(category->SetId(SPCAT_VOICES, FALSE)))
	{
		const wchar_t* languages[3] = { L";Language=409", L";Language=809", L"" };
		for (int i = 0; i < 3 && !found; i++)
		{
			wchar_t required[64];
			_snwprintf(required, 64, L"Gender=%ls%ls", gender, languages[i]);
			required[63] = 0;

			IEnumSpObjectTokens* list = nullptr;
			if (SUCCEEDED(category->EnumTokens(required, nullptr, &list)) && list)
			{
				ULONG count = 0;
				if (SUCCEEDED(list->GetCount(&count)) && count > 0)
					list->Item(0, &found);
				list->Release();
			}
		}
	}
	category->Release();
	return found;
}

// 0 the man's voice, 1 the woman's; created the first time it is asked for. Null when SAPI has none.
ISpVoice* GetVoice(int which)
{
	if (s_pVoice[which])
		return s_pVoice[which];
	if (s_bVoiceTried[which])
		return nullptr;
	s_bVoiceTried[which] = true;

	ISpObjectToken* token = FindToken(which ? L"Female" : L"Male");
	if (which && !token)
	{
		// no woman's voice installed: the man's, which the shaping raises
		s_bWomanIsMan = true;
		s_pVoice[1] = GetVoice(0);
		return s_pVoice[1];
	}

	ISpVoice* voice = nullptr;
	if (FAILED(CoCreateInstance(__uuidof(SpVoice), nullptr, CLSCTX_ALL, __uuidof(ISpVoice), (void**)&voice)) || !voice)
	{
		if (token)
			token->Release();
		return nullptr;
	}
	if (token)
	{
		voice->SetVoice(token);
		token->Release();
	}
	voice->SetVolume(100);
	s_pVoice[which] = voice;
	return voice;
}

// Whether a voice's name has this word in it, whatever the case.
bool NameHas(const char* name, const char* word)
{
	const size_t n = strlen(word);
	for (const char* p = name; *p; p++)
	{
		size_t i = 0;
		while (i < n && p[i] && (char)tolower((unsigned char)p[i]) == word[i])
			i++;
		if (i == n)
			return true;
	}
	return false;
}

// How good a default a voice is: a Natural or Neural voice (the newer, much less robotic ones, where the machine has them, see
// docs\TEXT_TO_SPEECH.txt) ahead of any other, a plain "Desktop" one last, and English of the US, then of the UK, ahead of other tongues.
int ScoreVoice(const char* name, unsigned langid, bool english)
{
	int score = 0;
	if (NameHas(name, "natural") || NameHas(name, "neural"))
		score += 12;
	else if (NameHas(name, "online"))
		score += 6;
	if (!NameHas(name, "desktop"))
		score += 1;
	if (langid == 0x409)
		score += 5;
	else if (langid == 0x809)
		score += 4;
	else if (english)
		score += 3;
	return score;
}

// Lists every installed SAPI voice, with its name and gender, for the player's pick.
void ListVoices()
{
	ISpObjectTokenCategory* category = nullptr;
	if (FAILED(CoCreateInstance(__uuidof(SpObjectTokenCategory), nullptr, CLSCTX_ALL, __uuidof(ISpObjectTokenCategory), (void**)&category))
		|| !category)
		return;

	IEnumSpObjectTokens* list = nullptr;
	if (SUCCEEDED(category->SetId(SPCAT_VOICES, FALSE)) && SUCCEEDED(category->EnumTokens(nullptr, nullptr, &list)) && list)
	{
		ULONG count = 0;
		list->GetCount(&count);
		int n = 0;
		for (ULONG i = 0; i < count && n < kMaxVoices; i++)
		{
			ISpObjectToken* token = nullptr;
			if (FAILED(list->Item(i, &token)) || !token)
				continue;

			VoiceEntry& e = s_voices[n];
			memset(&e, 0, sizeof(e));
			e.token = token;
			e.gender = '?';

			LPWSTR name = nullptr;
			if (SUCCEEDED(token->GetStringValue(nullptr, &name)) && name)
			{
				WideCharToMultiByte(CP_UTF8, 0, name, -1, e.name, (int)sizeof(e.name) - 1, nullptr, nullptr);
				CoTaskMemFree(name);
			}

			unsigned langid = 0;
			ISpDataKey* attributes = nullptr;
			if (SUCCEEDED(token->OpenKey(L"Attributes", &attributes)) && attributes)
			{
				LPWSTR gender = nullptr;
				if (SUCCEEDED(attributes->GetStringValue(L"Gender", &gender)) && gender)
				{
					const wchar_t g = (wchar_t)towlower(gender[0]);
					e.gender = (g == L'f') ? 'F' : ((g == L'm') ? 'M' : '?');
					CoTaskMemFree(gender);
				}
				// "409" (hexadecimal), or "409;9" for a voice that speaks more than one language: the first is its own
				LPWSTR language = nullptr;
				if (SUCCEEDED(attributes->GetStringValue(L"Language", &language)) && language)
				{
					langid = (unsigned)wcstoul(language, nullptr, 16) & 0xFFFF;
					CoTaskMemFree(language);
				}
				attributes->Release();
			}
			e.english = (langid & 0x3FF) == 0x09;
			e.score = ScoreVoice(e.name, langid, e.english);
			n++;
		}
		s_nVoices = n;
		list->Release();
	}
	category->Release();
}

// The voice a player picked: place index (from 0) in the list, made the first time it is asked for. Null when it cannot be made.
ISpVoice* VoiceForChoice(int index)
{
	if (index < 0 || index >= s_nVoices)
		return nullptr;
	if (s_pTokenVoice[index])
		return s_pTokenVoice[index];

	ISpVoice* voice = nullptr;
	if (FAILED(CoCreateInstance(__uuidof(SpVoice), nullptr, CLSCTX_ALL, __uuidof(ISpVoice), (void**)&voice)) || !voice)
		return nullptr;
	if (FAILED(voice->SetVoice(s_voices[index].token)))
	{
		voice->Release();
		return nullptr;
	}
	voice->SetVolume(100);
	s_pTokenVoice[index] = voice;
	return voice;
}

// The voices of this gender, best default first (a score tie keeps the list's order), with English only when the machine has any
// English one of that gender; their places in the list (from 0) go into out. Returns how many.
int Eligible(char gender, int* out, int cap)
{
	int n = 0;
	bool anyEnglish = false;
	for (int i = 0; i < s_nVoices; i++)
	{
		if (s_voices[i].gender == gender && s_voices[i].english)
			anyEnglish = true;
	}
	for (int i = 0; i < s_nVoices && n < cap; i++)
	{
		if (s_voices[i].gender == gender && (s_voices[i].english || !anyEnglish))
			out[n++] = i;
	}
	// a stable insertion sort on the score, best first
	for (int a = 1; a < n; a++)
	{
		const int v = out[a];
		int b = a - 1;
		while (b >= 0 && s_voices[out[b]].score < s_voices[v].score)
		{
			out[b + 1] = out[b];
			b--;
		}
		out[b + 1] = v;
	}
	return n;
}

// The man's (0) or woman's (1) default voice: the best of its gender among the listed ones; else the older way, by gender
// (GetVoice), which also makes the woman the man's when there is no woman's voice.
ISpVoice* DefaultVoice(int which)
{
	if (s_iDefault[which] == -2)
	{
		int list[kMaxVoices];
		s_iDefault[which] = Eligible(which ? 'F' : 'M', list, kMaxVoices) > 0 ? list[0] : -1;
	}
	if (s_iDefault[which] >= 0)
	{
		ISpVoice* voice = VoiceForChoice(s_iDefault[which]);
		if (voice)
			return voice;
	}
	return GetVoice(which);
}

// The speaker's variant: the n-th (from 1, wrapping round) of the voices of his kind, a Mech's and a bot's being the man's. Null when
// this machine lists none of that gender.
ISpVoice* VoiceForVariant(int kind, int variant)
{
	int list[kMaxVoices];
	const int n = Eligible(kind == H9TTS_VOICE_WOMAN ? 'F' : 'M', list, kMaxVoices);
	if (n <= 0 || variant < 1)
		return nullptr;
	return VoiceForChoice(list[(variant - 1) % n]);
}

// The samples SAPI wrote into the memory stream, copied into a buffer of our own (malloc'd; the caller frees it). A
// RIFF header, should the stream have written one, is skipped to its data chunk.
bool Collect(IStream* mem, short*& pcm, int& count)
{
	HGLOBAL global = nullptr;
	STATSTG stat;
	memset(&stat, 0, sizeof(stat));
	if (FAILED(GetHGlobalFromStream(mem, &global)) || !global || FAILED(mem->Stat(&stat, STATFLAG_NONAME)))
		return false;

	const unsigned char* bytes = (const unsigned char*)GlobalLock(global);
	if (!bytes)
		return false;

	const size_t size = (size_t)stat.cbSize.QuadPart;
	size_t start = 0;
	size_t length = size;
	if (size >= 12 && !memcmp(bytes, "RIFF", 4) && !memcmp(bytes + 8, "WAVE", 4))
	{
		start = size;
		length = 0;
		for (size_t at = 12; at + 8 <= size;)
		{
			unsigned int chunk = 0;
			memcpy(&chunk, bytes + at + 4, 4);
			if (!memcmp(bytes + at, "data", 4))
			{
				start = at + 8;
				length = (size - start < chunk) ? (size - start) : chunk;
				break;
			}
			at += 8 + (size_t)chunk + (chunk & 1);
		}
	}
	if (length > (size_t)kMaxBytes)
		length = (size_t)kMaxBytes;
	length &= ~(size_t)1;

	bool ok = false;
	if (length >= 2)
	{
		pcm = (short*)malloc(length);
		if (pcm)
		{
			memcpy(pcm, bytes + start, length);
			count = (int)(length / 2);
			ok = true;
		}
	}
	GlobalUnlock(global);
	return ok;
}

// Renders a line to samples: kRate, 16 bits, mono. False when SAPI could not.
bool Render(const Job& job, short*& pcm, int& count)
{
	// the listener's own pick for this kind of speaker, else the voice the speaker asked for, else the best the machine has
	ISpVoice* voice = nullptr;
	if (job.choice >= 1)
		voice = VoiceForChoice(job.choice - 1);
	if (!voice && job.variant >= 1)
		voice = VoiceForVariant(job.voice, job.variant);
	if (!voice)
		voice = DefaultVoice(job.voice == H9TTS_VOICE_WOMAN ? 1 : 0);
	if (!voice)
		return false;

	wchar_t wide[kTextBytes];
	if (MultiByteToWideChar(CP_UTF8, 0, job.text, -1, wide, kTextBytes) <= 0)
		return false;

	IStream* mem = nullptr;
	ISpStream* stream = nullptr;
	bool ok = false;
	if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &mem)) && mem
		&& SUCCEEDED(CoCreateInstance(__uuidof(SpStream), nullptr, CLSCTX_ALL, __uuidof(ISpStream), (void**)&stream)) && stream)
	{
		WAVEFORMATEX format;
		memset(&format, 0, sizeof(format));
		format.wFormatTag = WAVE_FORMAT_PCM;
		format.nChannels = 1;
		format.nSamplesPerSec = kRate;
		format.nAvgBytesPerSec = kRate * 2;
		format.nBlockAlign = 2;
		format.wBitsPerSample = 16;

		if (SUCCEEDED(stream->SetBaseStream(mem, kWaveFormatEx, &format))
			&& SUCCEEDED(voice->SetOutput(stream, FALSE))
			&& SUCCEEDED(voice->Speak(wide, SPF_IS_NOT_XML, nullptr)))
		{
			stream->Close();
			ok = Collect(mem, pcm, count);
		}
	}
	if (stream)
		stream->Release();
	if (mem)
		mem->Release();
	return ok;
}

// ---- the samples ------------------------------------------------------------------------------------------------

// A biquad filter (the RBJ cookbook's), direct form 1.
struct Biquad
{
	double b0, b1, b2, a1, a2;
	double x1, x2, y1, y2;
};

Biquad MakeLowPass(double hz, double q)
{
	Biquad f;
	memset(&f, 0, sizeof(f));
	const double w0 = 2.0 * 3.14159265358979323846 * hz / (double)kRate;
	const double alpha = sin(w0) / (2.0 * q);
	const double c = cos(w0);
	const double a0 = 1.0 + alpha;
	f.b0 = (1.0 - c) / 2.0 / a0;
	f.b1 = (1.0 - c) / a0;
	f.b2 = f.b0;
	f.a1 = -2.0 * c / a0;
	f.a2 = (1.0 - alpha) / a0;
	return f;
}

// A peaking filter: a bump (or, below 0 dB, a dip) of this many decibels at hz.
Biquad MakePeak(double hz, double q, double db)
{
	Biquad f;
	memset(&f, 0, sizeof(f));
	const double a = pow(10.0, db / 40.0);
	const double w0 = 2.0 * 3.14159265358979323846 * hz / (double)kRate;
	const double alpha = sin(w0) / (2.0 * q);
	const double c = cos(w0);
	const double a0 = 1.0 + alpha / a;
	f.b0 = (1.0 + alpha * a) / a0;
	f.b1 = -2.0 * c / a0;
	f.b2 = (1.0 - alpha * a) / a0;
	f.a1 = -2.0 * c / a0;
	f.a2 = (1.0 - alpha / a) / a0;
	return f;
}

double Run(Biquad& f, double x)
{
	const double y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
	f.x2 = f.x1;
	f.x1 = x;
	f.y2 = f.y1;
	f.y1 = y;
	return y;
}

// A gas mask: the line through two low-passes (a fourth-order roll-off at kMaskHz / (1 + strength)) and a resonant bump, then
// scaled back to kMaskMatch of the loudness (RMS) it had. A heavy low-pass alone only makes a voice quieter, which sounds like
// distance; keeping the loudness is what lets the dullness be heard as a mask.
void Mask(double* x, int count, double strength)
{
	if (strength > 2.0)
		strength = 2.0;
	Biquad low1 = MakeLowPass(kMaskHz / (1.0 + strength), kMaskQ);
	Biquad low2 = low1;
	Biquad bump = MakePeak(kMaskPeakHz, kMaskPeakQ, kMaskPeakDb * strength);
	double dry = 0.0, wet = 0.0;
	for (int i = 0; i < count; i++)
	{
		dry += x[i] * x[i];
		x[i] = Run(bump, Run(low2, Run(low1, x[i])));
		wet += x[i] * x[i];
	}
	if (dry < 1.0 || wet < 1.0)
		return;
	double scale = sqrt(dry / wet) * kMaskMatch;
	if (scale > 8.0)
		scale = 8.0;
	for (int i = 0; i < count; i++)
		x[i] *= scale;
}

short Clip(double v)
{
	if (v > 32767.0)
		return 32767;
	if (v < -32768.0)
		return -32768;
	return (short)v;
}

// The line as it will be heard: the samples (mono) through the robot filter and the gas mask, multiplied by the volume (under
// kHeadroom) and put into the ears by the pan (constant power: the two gains are the cosine and sine of an angle). Returns new
// stereo samples, count frames of them (malloc'd; the caller frees them), or null when there is no memory.
short* Shape(const short* pcm, int count, const Job& job)
{
	double* x = (double*)malloc((size_t)count * sizeof(double));
	short* out = (short*)malloc((size_t)count * 4);
	if (!x || !out)
	{
		free(x);
		free(out);
		return nullptr;
	}
	for (int i = 0; i < count; i++)
		x[i] = (double)pcm[i];

	// a robot's voice: the line ring-modulated, a Mech's with a lower hum than a bot's
	if (job.robot)
	{
		const double robotW = 2.0 * 3.14159265358979323846 * ((job.voice == H9TTS_VOICE_MECH) ? kRobotMechHz : kRobotBotHz) / (double)kRate;
		for (int i = 0; i < count; i++)
			x[i] *= (1.0 - kRobotDepth) + kRobotDepth * sin(robotW * (double)i);
	}
	if (job.muffled && job.muffle > 0.01f)
		Mask(x, count, (double)job.muffle);

	double pan = (double)job.pan;
	if (pan > 1.0)
		pan = 1.0;
	else if (pan < -1.0)
		pan = -1.0;
	const double theta = (pan * kPanRange + 1.0) * 3.14159265358979323846 / 4.0;
	const double gain = (double)job.volume * kHeadroom * kPanGain;
	const double left = gain * cos(theta);
	const double right = gain * sin(theta);
	for (int i = 0; i < count; i++)
	{
		out[2 * i] = Clip(x[i] * left);
		out[2 * i + 1] = Clip(x[i] * right);
	}
	free(x);
	return out;
}

// How fast the line is played: a Mech's slower and lower, a bot's faster and higher, a woman's with no woman's
// voice installed higher than the man's she is made of.
double PlaybackSpeed(int voice)
{
	switch (voice)
	{
	case H9TTS_VOICE_MECH:
		return 0.80;
	case H9TTS_VOICE_BOT:
		return 1.22;
	case H9TTS_VOICE_WOMAN:
		return s_bWomanIsMan ? 1.14 : 1.0;
	default:
		return 1.0;
	}
}

// Resamples a line to play speed times as fast, by linear interpolation: the samples are replaced (and the old ones
// freed) and count is the new length.
void Resample(short*& pcm, int& count, double speed)
{
	const int length = (int)((double)count / speed);
	if (length < 2)
		return;
	short* out = (short*)malloc((size_t)length * 2);
	if (!out)
		return;
	for (int i = 0; i < length; i++)
	{
		const double at = (double)i * speed;
		const int i0 = (int)at;
		const int i1 = (i0 + 1 < count) ? i0 + 1 : i0;
		const double frac = at - (double)i0;
		out[i] = (short)((double)pcm[i0] + ((double)pcm[i1] - (double)pcm[i0]) * frac);
	}
	free(pcm);
	pcm = out;
	count = length;
}

// ---- the sound card ---------------------------------------------------------------------------------------------

// Stops a slot's line, if it has one, and lets go of its device and buffer.
void StopSlot(Slot& slot)
{
	if (!slot.speaker)
		return;
	waveOutReset(slot.hwo);
	waveOutUnprepareHeader(slot.hwo, &slot.hdr, sizeof(WAVEHDR));
	waveOutClose(slot.hwo);
	free(slot.pcm);
	memset(&slot, 0, sizeof(slot));
}

// Frees the slots whose line has played out.
void Reap()
{
	for (int i = 0; i < kSlots; i++)
	{
		if (s_slots[i].speaker && (s_slots[i].hdr.dwFlags & WHDR_DONE))
			StopSlot(s_slots[i]);
	}
}

// Plays the samples (stereo, frames of them), taking them over: they are freed with the slot, or here when they cannot be played.
// His older line goes first. If as many voices as the player allows are playing already, this line takes the place of the
// quietest one when it is louder (by a fifth, so two equals do not keep cutting each other off), and is not spoken when it is not.
void Start(const Job& job, short* pcm, int frames)
{
	for (int i = 0; i < kSlots; i++)
	{
		if (s_slots[i].speaker == job.speaker)
			StopSlot(s_slots[i]);
	}
	int playing = 0;
	Slot* freeSlot = nullptr;
	Slot* quietest = nullptr;
	for (int i = 0; i < kSlots; i++)
	{
		if (!s_slots[i].speaker)
		{
			if (!freeSlot)
				freeSlot = &s_slots[i];
			continue;
		}
		playing++;
		if (!quietest || s_slots[i].level < quietest->level)
			quietest = &s_slots[i];
	}
	const int limit = job.maxVoices < 1 ? 1 : (job.maxVoices > kSlots ? kSlots : job.maxVoices);
	Slot* use = nullptr;
	if (freeSlot && playing < limit)
	{
		use = freeSlot;
	}
	else if (quietest && job.volume > quietest->level * 1.2f)
	{
		StopSlot(*quietest);
		use = quietest;
	}
	if (!use)
	{
		free(pcm);
		return;
	}

	WAVEFORMATEX format;
	memset(&format, 0, sizeof(format));
	format.wFormatTag = WAVE_FORMAT_PCM;
	format.nChannels = 2;
	format.nSamplesPerSec = kRate;
	format.nAvgBytesPerSec = kRate * 4;
	format.nBlockAlign = 4;
	format.wBitsPerSample = 16;

	memset(use, 0, sizeof(*use));
	if (waveOutOpen(&use->hwo, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) != MMSYSERR_NOERROR)
	{
		free(pcm);
		return;
	}
	use->hdr.lpData = (LPSTR)pcm;
	use->hdr.dwBufferLength = (DWORD)frames * 4;
	if (waveOutPrepareHeader(use->hwo, &use->hdr, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
	{
		waveOutClose(use->hwo);
		free(pcm);
		memset(use, 0, sizeof(*use));
		return;
	}
	if (waveOutWrite(use->hwo, &use->hdr, sizeof(WAVEHDR)) != MMSYSERR_NOERROR)
	{
		waveOutUnprepareHeader(use->hwo, &use->hdr, sizeof(WAVEHDR));
		waveOutClose(use->hwo);
		free(pcm);
		memset(use, 0, sizeof(*use));
		return;
	}
	use->pcm = pcm;
	use->speaker = job.speaker;
	use->level = job.volume;
	use->started = GetTickCount();
}

// ---- the worker -------------------------------------------------------------------------------------------------

void SpeakJob(const Job& job)
{
	short* pcm = nullptr;
	int count = 0;
	if (!Render(job, pcm, count))
	{
		// not one voice could be made: there is no SAPI to speak with
		if (!GetVoice(0) && !GetVoice(1))
			s_bBroken = true;
		return;
	}
	// the kind's speed, and a step of depth for each step the speaker asked for (or his slot's): both move tempo and pitch together
	const double speed = PlaybackSpeed(job.voice) * pow(kDepthStep, (double)job.depth);
	if (speed < 0.999 || speed > 1.001)
		Resample(pcm, count, speed);
	short* stereo = Shape(pcm, count, job);
	free(pcm);
	if (!stereo)
		return;
	Start(job, stereo, count);
}

void WorkerMain()
{
	if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)))
	{
		s_bBroken = true;
		return;
	}
	memset(s_slots, 0, sizeof(s_slots));
	ListVoices();

	for (;;)
	{
		Job job;
		bool have = false;
		bool purge[256];
		{
			std::unique_lock<std::mutex> lock(s_mtx);
			bool playing = false;
			for (int i = 0; i < kSlots; i++)
			{
				if (s_slots[i].speaker)
					playing = true;
			}
			if (playing)
				s_cv.wait_for(lock, std::chrono::milliseconds(30));
			else
				s_cv.wait(lock, [] { return s_bQuit || s_iQueued > 0; });
			if (s_bQuit)
				break;

			memcpy(purge, s_bPurge, sizeof(purge));
			memset(s_bPurge, 0, sizeof(s_bPurge));
			if (s_iQueued > 0)
			{
				job = s_queue[0];
				memmove(&s_queue[0], &s_queue[1], sizeof(Job) * (size_t)(s_iQueued - 1));
				s_iQueued--;
				have = true;
			}
		}

		for (int i = 0; i < kSlots; i++)
		{
			if (s_slots[i].speaker && purge[s_slots[i].speaker & 255])
				StopSlot(s_slots[i]);
		}
		Reap();
		if (have)
			SpeakJob(job);
	}

	for (int i = 0; i < kSlots; i++)
		StopSlot(s_slots[i]);
	if (s_pVoice[1] && s_pVoice[1] != s_pVoice[0])
		s_pVoice[1]->Release();
	if (s_pVoice[0])
		s_pVoice[0]->Release();
	s_pVoice[0] = s_pVoice[1] = nullptr;
	for (int i = 0; i < kMaxVoices; i++)
	{
		if (s_pTokenVoice[i])
			s_pTokenVoice[i]->Release();
		s_pTokenVoice[i] = nullptr;
	}
	for (int i = 0; i < s_nVoices; i++)
	{
		if (s_voices[i].token)
			s_voices[i].token->Release();
		s_voices[i].token = nullptr;
	}
	s_nVoices = 0;
	CoUninitialize();
}
} // namespace

// ---- the platform interface (h9_tts_platform.h) -------------------------------------------------------------------

bool H9TtsPlat_Init()
{
	if (s_pThread)
		return true;
	{
		std::lock_guard<std::mutex> lock(s_mtx);
		s_bQuit = false;
		s_iQueued = 0;
		memset(s_bPurge, 0, sizeof(s_bPurge));
	}
	s_bBroken = false;
	s_pThread = new std::thread(WorkerMain);
	return true;
}

bool H9TtsPlat_Available()
{
	return s_pThread != nullptr && !s_bBroken;
}

void H9TtsPlat_Shutdown()
{
	if (!s_pThread)
		return;
	{
		std::lock_guard<std::mutex> lock(s_mtx);
		s_bQuit = true;
	}
	s_cv.notify_all();
	s_pThread->join();
	delete s_pThread;
	s_pThread = nullptr;
}

int H9TtsPlat_VoiceCount()
{
	return s_nVoices;
}

bool H9TtsPlat_VoiceInfo(int index, char* name, int size, char* gender)
{
	if (index < 1 || index > s_nVoices || !name || size < 2)
		return false;
	strncpy(name, s_voices[index - 1].name, (size_t)size - 1);
	name[size - 1] = 0;
	if (gender)
		*gender = s_voices[index - 1].gender;
	return true;
}

void H9TtsPlat_Speak(const H9TtsLine& line)
{
	const int speaker = line.speaker;
	const char* text = line.text;
	if (!s_pThread || s_bBroken || !text || !text[0] || speaker < 1 || speaker > 255)
		return;
	{
		std::lock_guard<std::mutex> lock(s_mtx);

		// his older line, if it is still waiting, goes
		int keep = 0;
		for (int i = 0; i < s_iQueued; i++)
		{
			if (s_queue[i].speaker != speaker)
				s_queue[keep++] = s_queue[i];
		}
		s_iQueued = keep;
		// a full queue gives up its oldest line
		if (s_iQueued == kQueue)
		{
			memmove(&s_queue[0], &s_queue[1], sizeof(Job) * (size_t)(kQueue - 1));
			s_iQueued--;
		}

		Job& job = s_queue[s_iQueued++];
		job.speaker = speaker;
		job.voice = line.voice;
		job.muffled = line.muffled;
		job.robot = line.robot && (line.voice == H9TTS_VOICE_MECH || line.voice == H9TTS_VOICE_BOT);
		job.choice = (line.choice >= 1 && line.choice <= kMaxVoices) ? line.choice : 0;
		job.variant = line.variant > 0 ? line.variant : 0;
		job.depth = line.depth < -H9TTS_DEPTH_MAX ? -H9TTS_DEPTH_MAX : (line.depth > H9TTS_DEPTH_MAX ? H9TTS_DEPTH_MAX : line.depth);
		job.maxVoices = line.maxVoices;
		job.muffle = line.muffle;
		job.pan = line.pan;
		job.volume = line.volume;
		int n = 0;
		for (; text[n] && n < kTextBytes - 1; n++)
			job.text[n] = text[n];
		job.text[n] = 0;

		// and the one of his that is playing stops at once
		s_bPurge[speaker] = true;
	}
	s_cv.notify_one();
}

#endif // _WIN32 && !__EMSCRIPTEN__
