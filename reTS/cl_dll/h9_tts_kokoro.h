// ---- H9 text to speech: the Kokoro voices ---------------------------------------------------------------------------
// The Windows client can speak with Kokoro, a neural voice, instead of the system's SAPI voices. Two sources give a line
// its raw samples:
//   the line pack   lines known ahead of time (the bots' fixed chat), synthesised once, offline, and shipped in
//                   h9tts\lines\lines.h9pk: heard at once
//   the helper      h9kokoro64.exe, a 64-bit process the client starts and talks to over a named pipe (the client is 32-bit
//                   and ONNX Runtime has no 32-bit build that is fast enough): it turns the text into speech phrase by phrase
// and this module does the rest, the same for both: the speaker's voice from the catalogue (h9tts\voices.txt), the depth,
// the gas mask and the machine chains (h9tts\chains.txt), the level, and the resample to the mixer's rate. A line that
// neither source can give is the platform's to speak with the system voice (cl_h9_tts_engine auto) or to drop (kokoro).
//
// Everything here is called from the speech thread of h9_tts_win.cpp, except Describe, Usable and Start, which any thread may call.
// docs\TEXT_TO_SPEECH.txt (the Kokoro section) is the guide.
#pragma once

#include "h9_tts_platform.h"

#if H9TTS_HAVE_KOKORO

#include <stdint.h>

namespace h9tts
{
namespace kokoro
{
// cl_h9_tts_engine
enum
{
	kEngineSystem = 0, // the system voices only (SAPI); Kokoro is never started
	kEngineAuto = 1,   // Kokoro when it is ready, the system voice while it is not
	kEngineKokoro = 2  // Kokoro only: a line it cannot give is dropped
};

enum Outcome
{
	kSpoken,      // the line was handed to the sink
	kUnavailable, // Kokoro cannot give this line now (not ready, no data): the platform may use the system voice
	kFailed,      // it tried and could not
	kCancelled    // the sink said the line is not wanted any more
};

// Where the shaped pieces of a line go: the platform's mixer.
class Sink
{
public:
	virtual ~Sink() {}
	// One piece of the line: mono 16-bit samples at the rate given to Init. The sink copies them. first and last mark the piece's place in the line.
	virtual void Chunk(const int16_t* pcm, int frames, bool first, bool last) = 0;
	// True when the line is not wanted any more (a Stop, a newer line of the speaker): the module stops working on it.
	virtual bool Cancelled() = 0;
	// Called about every 10 ms while the speech thread waits for the helper to make a piece of the line: the sink may use the time, but must not call
	// Speak with a line that needs the helper (a line of the pack is fine).
	virtual void Idle() {}
};

// One line to speak, as the platform has it.
struct Line
{
	int voice;        // H9TTS_VOICE_*
	bool droid;       // a bot's voice that is the droid kind
	int variant;      // 0: the kind's default; 1 to 99: the n-th variant of the kind, wrapping round
	int depth;        // steps higher (above 0) or lower
	bool muffled;     // a gas mask
	float muffle;     // its strength, 0 to 2
	bool robot;       // the machine chains of a Mech, a bot or a droid
	int engine;       // kEngine*
	int threads;      // cl_h9_tts_threads, 0 automatic
	bool packOnly;    // speak it from the line pack or not at all; the helper is not asked (for a line spoken while the helper is busy with another)
	unsigned arrived; // GetTickCount() when the line reached the client (0: it has just come)
	int budgetMs;     // how long after it arrived the line may take to start to sound (0: kStartBudgetMs)
	const char* text; // UTF-8, cleaned
};

// A line must start to sound within this long of its arrival, or not by the helper: the platform speaks it with the system voice at once (cl_h9_tts_engine
// auto) or drops it (kokoro). The time a line waited for the speech thread counts. A line of the pack is not held to it: it starts at once.
static const int kStartBudgetMs = 3000;

// Reads the data (h9tts\voices.txt, chains.txt, the line pack) from the folder next to the client library's. outRate is the
// mixer's sample rate. Cheap: no process is started. False when there is nothing to speak with.
bool Init(int outRate);

// Stops the helper and lets go of the data.
void Shutdown();

// The platform spoke a line itself with the system voice because it had waited too long behind the line the helper was making: cl_h9_tts_state counts it.
void NoteSystemVoice();

// Whether the line pack holds this line (as this speaker's variant has it): Speak with packOnly speaks it at once.
bool InPack(const Line& line);

// Whether this module can speak a line now or after a short wait: the data is there and, for a line the pack does not hold, the
// helper has been found. False on a machine without the data.
bool Usable();

// Asks for the helper to be started if it is not (a map has been joined, or the first line is coming). Returns at once.
void Start(int threads);

// Once a frame (the game's thread): the length of the frame in seconds. While the helper is making a line the frames are compared with the
// ones before it (h9_tts_framewatch.h); when they get longer the helper is asked for one thread fewer (never fewer than 2).
void Frame(double dt);

// The state, as lines for the console (cl_h9_tts_state): written into out, NUL ended; returns the length.
int Describe(char* out, int size);

// Stops the helper and starts it again (cl_h9_tts_reload).
void Reload();

// Whether the helper is up and has loaded its model (for the tests and the state listing).
bool HelperReady();

// Speaks one line: shapes what the pack or the helper gives and hands it to the sink, piece by piece. Blocks until the line is
// done, which is the speech thread's way. kUnavailable is also the answer for a line the helper could not start within the line's budget: it was
// cancelled, nothing was spoken, and what the helper still makes for it is thrown away.
Outcome Speak(const Line& line, Sink& sink);
} // namespace kokoro
} // namespace h9tts

#endif // H9TTS_HAVE_KOKORO
