// ---- H9 text to speech: the link to the Kokoro helper process ------------------------------------------------------------------
// Starts h9kokoro64.exe, talks to it over a named pipe, watches it. The helper is a program the client runs, so the client checks it first and never
// trusts what it sends:
//   * the program files named in h9tts\manifest.txt (bin/h9kokoro64.exe, bin/onnxruntime.dll ...) are checksummed (SHA-256) and must match it
//   * the pipe has a name made for this run, is made by the client (the helper only connects), has no other user's access and takes no remote client
//   * the helper runs hidden, below normal priority, in a job object that kills it when the client's process ends, with a memory limit
//   * every frame it sends is checked (h9_tts_proto.h): head, type, size, sequence, the line it belongs to; a deadline is kept for each piece after
//     the first and for the end, and a helper that misses one is killed and, after a pause, started again
//   * the first piece has a deadline of the caller's (a line must start soon or not at all): when it is missed the line is cancelled, the helper is left
//     alone (slow is not dead) and whatever it still sends for that line is read and dropped before the next line is asked for; a helper that does not
//     answer the cancel in time is killed
//   * it is started only when the player has the Kokoro voices on, and stopped (killed) when the client's library is unloaded
// The helper's state and the reason for a failure are for cl_h9_tts_state. The class is used from two kinds of thread: Ensure, Stop, Reload and
// Describe from any, Synthesize from the speech thread only.
#pragma once

#include "h9_tts_platform.h"

#if H9TTS_HAVE_KOKORO

#include <stdint.h>

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace h9tts
{
namespace kokoro
{
class HelperLink
{
public:
	enum State
	{
		kOff,      // not running, may be started
		kStarting, // being started (the model is loading)
		kReady,
		kBroken    // failed and waiting to be tried again, or given up (see Describe)
	};

	struct Status
	{
		State state = kOff;
		std::string reason;     // why it failed, or what it is doing
		int threads = 0;        // the helper's thread count
		int loadMs = 0;         // how long its model took to load
		int ortMajorMinor = 0;  // ONNX Runtime version, major << 8 | minor
		int starts = 0;         // times it was started
		int failures = 0;       // times it failed since it last worked
		int lines = 0;          // lines it made
		int cacheHits = 0;      // of them, from its cache
		int lastFirstMs = 0;    // the last line: from the request to the first piece, milliseconds
		int lastTotalMs = 0;    // and to the end
		int lateLines = 0;      // lines whose first piece did not come in time (cancelled)
		int busyLines = 0;      // lines the helper declined because it had worked more than its share of the last ten seconds
		bool givenUp = false;   // too many failures: only cl_h9_tts_reload starts it again
	};

	struct Piece
	{
		const int16_t* pcm;
		int samples;
		bool first, last;
		bool cached;
	};

	typedef std::function<void(const Piece&)> PieceFn;
	typedef std::function<bool()> CancelFn;

	enum Result
	{
		kOk,
		kNotReady, // the helper is not ready: nothing was asked of it
		kCancelled,
		kLate,     // the first piece did not come within the time given: the line was cancelled, the helper is fine
		kBusy,     // the helper declined the line (or is still finishing a cancelled one): nothing is coming
		kFailed    // it was asked and failed (or was killed for being late)
	};

	HelperLink();
	~HelperLink();

	// The h9tts folder and the checksum of voices.txt the helper must report to be the same catalogue.
	void Configure(const std::wstring& dir, uint32_t catalogueCrc);

	// Starts the helper if it is off and not waiting out a failure (threads 0: the game chooses). Returns at once; the start is made by a thread of its own.
	void Ensure(int threads);

	// Kills the helper. Start again with Ensure.
	void Stop();

	// Kills the helper, joins the thread that was starting it and closes its handles: the last call before the library goes.
	void Shutdown();

	// The thread count of a helper that is ready, else 0.
	int ThreadsNow();

	// Stop, forget the failures, start again.
	void Reload(int threads);

	State GetState();
	Status Describe();

	// The speech thread: one line. onPiece is called for each piece as it arrives; cancelled is asked between pieces. At most kMaxChars bytes of text.
	// The first piece must arrive within firstMs milliseconds (0: the default of 9 s), else the result is kLate.
	Result Synthesize(int kind, int index, bool stream, const char* text, unsigned firstMs, const PieceFn& onPiece, const CancelFn& cancelled);

	// Any thread, about once a frame: a helper that has not answered a cancel for too long is killed.
	void Watch();

	// The thread count the game chooses when the player has none set: the machine's logical processors, 8 at the most. 0 on a machine with fewer than 4, too small for the voices.
	static int AutoThreads();

private:
	void StartMain(int threads);
	bool VerifyFiles(std::string* why);
	void Kill();
	void Fail(const std::string& why);
	bool ReadExact(void* buf, uint32_t n, uint32_t timeoutMs, int* what);
	bool WriteAll(const void* buf, uint32_t n);
	bool ReadFrame(uint32_t* type, std::vector<uint8_t>& payload, uint32_t timeoutMs, int* what);
	bool SendFrame(uint32_t type, const uint8_t* payload, uint32_t length);
	bool DrainCancelled(unsigned maxWaitMs);

	std::mutex m_mtx;      // the state and the counters
	std::wstring m_dir;
	uint32_t m_catalogueCrc = 0;
	Status m_status;
	std::thread* m_starter = nullptr;
	unsigned m_retryAt = 0; // GetTickCount() before which a failed helper is not started again
	int m_wantThreads = 0;
	uint32_t m_nextId = 1;
	std::atomic<uint32_t> m_drainId{ 0 };       // a cancelled line whose DONE has not been read yet (0: none)
	std::atomic<unsigned> m_drainSince{ 0 };    // GetTickCount() when it was cancelled

	// the process and the pipe; the starter thread makes them, the speech thread uses them once the state is kReady
	void* m_proc = nullptr;
	void* m_pipe = nullptr;
	void* m_job = nullptr;
	void* m_readEvent = nullptr;
	void* m_writeEvent = nullptr;
	std::mutex m_ioMtx;
};
} // namespace kokoro
} // namespace h9tts

#endif // H9TTS_HAVE_KOKORO
