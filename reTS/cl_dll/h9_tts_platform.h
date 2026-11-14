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

// The Kokoro voices (h9_tts_kokoro.h) are the Windows client's: the helper process they need is a Windows program. The browser keeps
// its own voices, any other platform has none.
#if defined(_WIN32) && !defined(__EMSCRIPTEN__)
#define H9TTS_HAVE_KOKORO 1
#else
#define H9TTS_HAVE_KOKORO 0
#endif

// One line to speak. Everything the platform needs is in here; h9_tts.cpp fills it in from the message and the cvars.
struct H9TtsLine
{
	int speaker;       // 1 to 255: a speaker's lines follow one another; a newer line replaces his older one that has not begun
	int voice;         // H9TTS_VOICE_*
	bool muffled;      // a gas mask is on
	float muffle;      // how strongly a gas mask muffles (cl_h9_tts_muffle): 0 not at all, 1 the standard, 2 heavy
	float volume;      // 0 up, 1 being a full voice
	float pan;         // -1 the left ear, 0 the middle, 1 the right ear; the browser has no pan and ignores it
	bool global;       // the server sent the line to everyone whatever the distance: heard from no direction, so pan is 0
	const char* text;  // UTF-8, already cleaned, at most H9TTS_TEXT_MAX bytes
	int choice;        // the place of the voice a player picked for this kind of speaker, 0 leaving it to the platform
	int variant;       // 0: the platform's best voice of the kind; 1 and up: the n-th of the voices of that kind this machine has
	int depth;         // -H9TTS_DEPTH_MAX to +H9TTS_DEPTH_MAX: steps lower or higher than the voice is
	bool robot;        // a Mech's or a bot's voice goes through the robot filter (a platform that has no audio to filter ignores it)
	int maxVoices;     // 1 to 8: the voices that may play together; a line beyond them waits for a voice and cuts none off
	bool droid;        // the bot voice is the droid kind (the server says so in the tail of the message); only the Kokoro voices tell it from a bot
	int engine;        // cl_h9_tts_engine: 0 the system voice only, 1 Kokoro when it is ready, 2 Kokoro only; a platform without Kokoro ignores it
	int threads;       // cl_h9_tts_threads: the threads the Kokoro helper synthesises with, 0 leaving it to the game
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

// Silences everything: the voices fade out and the lines that wait go.
void H9TtsPlat_Stop();

// The Kokoro voices, where the platform has them (H9TTS_HAVE_KOKORO; the others answer as if there were none).
// Called every frame with the player's settings: engine is cl_h9_tts_engine (0: the system voice only, and nothing is started) and
// threads cl_h9_tts_threads. wanted says speech is to be expected on this server (it has the plugin and has asked for the game's
// voice), so the platform starts the helper process if it is not running, to have it ready when the first line comes.
void H9TtsPlat_KokoroStart(int engine, int threads, bool wanted);

// Called every frame with the length of the frame in seconds: the Kokoro voices watch whether the game's frames get longer while the helper works
// and, if they do, ask the helper for fewer threads.
void H9TtsPlat_KokoroFrame(double dt);

// Writes the state of the Kokoro voices as console lines into out; returns the length, 0 when the platform has none.
int H9TtsPlat_KokoroState(char* out, int size);

// Stops the helper and starts it again.
void H9TtsPlat_KokoroReload();
