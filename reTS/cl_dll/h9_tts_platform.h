// ---- H9 text to speech: what h9_tts.cpp asks of a platform's speech -------------------------------------------
// h9_tts.cpp (the H9Tts message, the cvars, the client's own limits) is the same everywhere; a platform only speaks:
// h9_tts_win.cpp with Windows SAPI, h9_tts_web.cpp with the browser's speech synthesis. Any other platform has no
// speech, and h9_tts.cpp answers for it. This header includes nothing of the client's, so the Windows file can take
// the Windows headers alone.
#pragma once

// The voices of the H9Tts message.
enum
{
	H9TTS_VOICE_MAN = 0,
	H9TTS_VOICE_WOMAN = 1,
	H9TTS_VOICE_MECH = 2,
	H9TTS_VOICE_BOT = 3,
};

#define H9TTS_TEXT_MAX 160 // bytes of a line the client speaks, whatever a message carries
#define H9TTS_DEPTH_MAX 12 // the most steps, either way, a voice is moved from its natural pitch

#if defined(_WIN32) || defined(__EMSCRIPTEN__)
#define H9TTS_HAVE_SPEECH 1
#endif

// One line to speak. Everything the platform needs is in here; h9_tts.cpp fills it in from the message and the cvars.
struct H9TtsLine
{
	int speaker;       // 1 to 255: a speaker's newer line replaces his older one
	int voice;         // H9TTS_VOICE_*
	bool muffled;      // a gas mask is on
	float muffle;      // how strongly a gas mask muffles (cl_h9_tts_muffle): 0 not at all, 1 the standard, 2 heavy
	float volume;      // 0 up, 1 being a full voice
	float pan;         // -1 the left ear, 0 the middle, 1 the right ear; the browser has no pan and ignores it
	const char* text;  // UTF-8, already cleaned, at most H9TTS_TEXT_MAX bytes
	int choice;        // the place of the voice a player picked for this kind of speaker, 0 leaving it to the platform
	int variant;       // 0: the platform's best voice of the kind; 1 and up: the n-th of the voices of that kind this machine has
	int depth;         // -H9TTS_DEPTH_MAX to +H9TTS_DEPTH_MAX: steps lower or higher than the voice is
	bool robot;        // a Mech's or a bot's voice goes through the robot filter (a platform that has no audio to filter ignores it)
	int maxVoices;     // 1 to 3: the voices that may play together; a line nearer than the ones playing takes the quietest's place
};

// Starts the platform's speech. False when this machine cannot speak at all.
bool H9TtsPlat_Init();

// Whether it can speak: false once it has found out that it cannot (no SAPI, no voice, no speechSynthesis).
bool H9TtsPlat_Available();

// Stops every line and lets go of the voices.
void H9TtsPlat_Shutdown();

// How many voices the platform lists for a player to pick from, 0 while it has not listed them yet (or has none). A voice's
// place in the list, from 1, is what cl_h9_tts_voice_man, _woman, _mech and _bot hold.
int H9TtsPlat_VoiceCount();

// The name of the voice at place index (from 1) and its gender: 'M', 'F' or '?'. False when there is no such place.
bool H9TtsPlat_VoiceInfo(int index, char* name, int size, char* gender);

// Speaks a line. Never waits for the voice.
void H9TtsPlat_Speak(const H9TtsLine& line);
