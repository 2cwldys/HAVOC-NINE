// ---- H9 text to speech: the Kokoro voices -------------------------------------------------------------------------------
// See h9_tts_kokoro.h. The data folder is h9tts, next to the client library's own folder (ts\cl_dlls\client.dll -> ts\h9tts):
//
//   voices.txt          the voice catalogue (h9_tts_catalogue.h): the voice variants of each kind and their blends
//   chains.txt          the effect chains (h9_tts_chains.h): the gas masks and the machine sounds
//   lines\lines.h9pk    the line pack (h9_tts_pack.h)
//   manifest.txt        the checksums of the helper's program files (h9_tts_kokoro_link.cpp)
//   bin\h9kokoro64.exe  the helper, with its onnxruntime.dll
//
// A line is shaped here whatever its source: the speaker's variant picks the catalogue voice, the voice's own depth and the
// speaker's are one resample together with the kind's pitch and tempo, a gas mask or a machine chain is run, the level is
// brought to the same loudness as the system voices, and the result is resampled to the mixer's rate. A line the helper makes
// in several pieces is shaped piece by piece: each piece is levelled and filtered alone (the trim at each end of a piece
// leaves it silent there), and the breathing of a gas mask is put before the first piece and after the last one only.

#include "h9_tts_kokoro.h"

#if H9TTS_HAVE_KOKORO

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "h9_tts_catalogue.h"
#include "h9_tts_framewatch.h"
#include "h9_tts_kokoro_link.h"
#include "h9_tts_pack.h"

namespace h9tts
{
namespace kokoro
{
namespace
{
const double kModelRate = 24000.0; // what Kokoro writes and what the pack holds
const unsigned kIdleStopMs = 20u * 60u * 1000u; // the helper is let go of after this long without a line
const int kMinStartMs = 1200;                   // the helper's first piece takes 0.9 to 1.3 s at the quickest (a short line, 4 threads): with less than this left it is not asked
const int kLateRunMax = 3;                      // a helper that is late with this many lines in a row is too slow for this machine just now
const unsigned kRestMs = 60000;                 // and is not asked for this long: its lines would each wait out their time before the system voice took them
const int kSystemRenderMs = 250;                // the system voice needs 0.05 to 0.3 s to render a line: that much of the budget is kept for it

struct State
{
	std::mutex mtx; // guards the data below that Describe and Usable read, against Init and Shutdown
	bool inited = false;
	bool dataOk = false;   // the catalogue and the chains are loaded and agree
	bool helperFiles = false; // bin\h9kokoro64.exe and manifest.txt are there
	int outRate = 22050;   // the mixer's rate
	std::wstring dir;      // the h9tts folder
	std::string reason;    // why the data is not usable, for Describe
	h9fx::Catalogue cat;
	h9fx::ChainSet chains;
	Pack pack;
	size_t packLines = 0;
	uint32_t catalogueCrc = 0;
	HelperLink link;
	std::atomic<bool> usable;
	std::atomic<unsigned> lastLine;   // GetTickCount() of the last line spoken
	std::atomic<int> spoken;          // lines handed to a sink
	std::atomic<int> fromPack;        // of them, from the line pack
	std::atomic<int> fromHelper;      // and from the helper
	std::atomic<int> unavailable;     // lines the Kokoro voices could not give (the system voice, or nothing, spoke them)
	std::atomic<int> waitedTooLong;   // of them, lines that had no time left for the helper when the speech thread came to them
	std::atomic<int> late;            // of them, lines whose first piece did not come within the time left
	std::atomic<int> busy;            // of them, lines the helper declined as too busy
	std::atomic<int> resting;         // of them, lines not asked of the helper because it was resting after being late
	std::atomic<int> servedBySystem;  // lines the platform gave to the system voice itself while the helper made another (they never came to Speak)
	std::atomic<int> lateRun;         // lines in a row whose first piece was late
	std::atomic<unsigned> restUntil;  // GetTickCount() until which the helper is left alone (0: not resting)
	std::atomic<int> lastToSinkMs;    // the last helper line: from asking to the first sound handed to the mixer
	std::atomic<int> lastEngine;      // cl_h9_tts_engine as the last line had it
	std::atomic<bool> helperBusy;     // the speech thread is waiting for the helper to make a line
	std::atomic<int> threadCap;       // the most threads the game's frame time allows (0: no cap yet)
	FrameWatch watch;                 // the game's thread only
	State() : usable(false), lastLine(0), spoken(0), fromPack(0), fromHelper(0), unavailable(0), waitedTooLong(0), late(0), busy(0), resting(0), servedBySystem(0), lateRun(0), restUntil(0), lastToSinkMs(0), lastEngine(0), helperBusy(false), threadCap(0) {}
};

State g;

// ---- the data -----------------------------------------------------------------------------------------------------------

// The h9tts folder next to the client library's folder, or one named by the working directory: ts\cl_dlls\client.dll -> ts\h9tts.
bool FindDataDir(std::wstring& out)
{
	std::vector<std::wstring> candidates;
	HMODULE self = nullptr;
	if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCWSTR)&FindDataDir, &self) && self)
	{
		wchar_t path[1024];
		const DWORD n = GetModuleFileNameW(self, path, 1024);
		if (n > 0 && n < 1024)
		{
			std::wstring p(path, n);
			// strip the file name, then the folder cl_dlls
			for (int strip = 0; strip < 2; strip++)
			{
				const size_t cut = p.find_last_of(L"\\/");
				if (cut == std::wstring::npos)
					break;
				p.resize(cut);
			}
			candidates.push_back(p + L"\\h9tts");
		}
	}
	candidates.push_back(L"ts\\h9tts");
	candidates.push_back(L"h9tts");
	for (size_t i = 0; i < candidates.size(); i++)
	{
		const DWORD attr = GetFileAttributesW((candidates[i] + L"\\voices.txt").c_str());
		if (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY))
		{
			out = candidates[i];
			return true;
		}
	}
	return false;
}

bool FileExists(const std::wstring& path)
{
	const DWORD attr = GetFileAttributesW(path.c_str());
	return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

bool ReadFileW(const std::wstring& path, std::string& text, size_t maxBytes)
{
	FILE* f = _wfopen(path.c_str(), L"rb");
	if (!f)
		return false;
	text.clear();
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
	{
		text.append(buf, n);
		if (text.size() > maxBytes)
		{
			fclose(f);
			return false;
		}
	}
	fclose(f);
	return true;
}

void SetReason(const char* why)
{
	g.reason = why;
}

// ---- shaping ------------------------------------------------------------------------------------------------------------

int KindOf(const Line& line)
{
	if (line.voice == H9TTS_VOICE_BOT && line.droid)
		return h9fx::KIND_DROID;
	if (line.voice == H9TTS_VOICE_MECH)
		return h9fx::KIND_MECH;
	if (line.voice == H9TTS_VOICE_BOT)
		return h9fx::KIND_BOT;
	if (line.voice == H9TTS_VOICE_WOMAN)
		return h9fx::KIND_WOMAN;
	return h9fx::KIND_MAN;
}

// The chain's stages with its breathing (breath=pre,post,burst,leak,centre) cut to the piece: no inhale unless this is the first piece of the line,
// no exhale unless it is the last.
std::string StagesForPiece(const std::string& stages, bool first, bool last)
{
	const size_t at = stages.find("breath=");
	if (at == std::string::npos || (first && last))
		return stages;
	size_t end = stages.find(' ', at);
	if (end == std::string::npos)
		end = stages.size();
	std::vector<std::string> p;
	size_t from = at + 7;
	while (from <= end)
	{
		size_t comma = stages.find(',', from);
		if (comma == std::string::npos || comma > end)
			comma = end;
		p.push_back(stages.substr(from, comma - from));
		from = comma + 1;
	}
	if (p.size() < 2)
		return stages;
	if (!first)
		p[0] = "0";
	if (!last)
		p[1] = "0";
	std::string tok = "breath=";
	for (size_t i = 0; i < p.size(); i++)
		tok += (i ? "," : "") + p[i];
	return stages.substr(0, at) + tok + stages.substr(end);
}

// The raw trimmed line (24 kHz) as the listener hears it, before the volume and the pan: the variant's own depth and the speaker's
// are one resample with the kind's pitch and tempo, then the level, the chain and the level again (h9fx::RenderFx).
//   a Mech, a bot, a droid   the kind's chain, with robot 0 the chain's pitch and tempo only
//   a man, a woman           the variant's mask chain when a gas mask is on and the strength is above 0
void Shape(h9fx::Vec& x, const h9fx::Variant& v, const Line& line, bool first, bool last)
{
	const bool machine = v.kind >= h9fx::KIND_MECH;
	const bool mask = !machine && line.muffled && line.muffle > 0.01f;
	std::string chain = "-";
	bool stages = false;
	double s = 1.0;
	if (machine)
	{
		chain = v.chain;
		stages = line.robot;
	}
	else if (mask)
	{
		chain = v.mask;
		stages = true;
		s = line.muffle > 2.0f ? 2.0 : (double)line.muffle;
	}
	int depth = v.depth + line.depth;
	depth = depth < -12 ? -12 : (depth > 12 ? 12 : depth);
	if (stages && (!first || !last))
	{
		h9fx::ChainSet cs = g.chains;
		std::map<std::string, h9fx::ChainDef>::iterator it = cs.chain.find(chain);
		if (it != cs.chain.end())
			it->second.stages = StagesForPiece(it->second.stages, first, last);
		h9fx::RenderFx(x, cs, chain, s, depth, stages);
		return;
	}
	h9fx::RenderFx(x, g.chains, chain, s, depth, stages);
}

// Mono doubles (24 kHz) to the mixer's mono 16 bit samples: a resample when the rates differ, then rounding.
void ToMixer(h9fx::Vec& x, std::vector<int16_t>& out)
{
	if (g.outRate != (int)kModelRate)
		h9fx::Resample(x, kModelRate / (double)g.outRate);
	out.resize(x.size());
	for (size_t i = 0; i < x.size(); i++)
	{
		double v = x[i] * 32767.0;
		v = v > 32767.0 ? 32767.0 : (v < -32768.0 ? -32768.0 : v);
		out[i] = (int16_t)(v >= 0.0 ? v + 0.5 : v - 0.5);
	}
}

// One piece (raw samples at 24 kHz) through the shaping to the sink.
bool PlayPiece(const int16_t* raw, int samples, const h9fx::Variant& v, const Line& line, Sink& sink, bool first, bool last)
{
	if (samples < 64)
		return false;
	h9fx::Vec x((size_t)samples);
	for (int i = 0; i < samples; i++)
		x[(size_t)i] = (double)raw[i] / 32768.0;
	Shape(x, v, line, first, last);
	std::vector<int16_t> pcm;
	ToMixer(x, pcm);
	sink.Chunk(pcm.data(), (int)pcm.size(), first, last);
	return true;
}

// The helper is for this player's setting: engine auto needs a machine big enough for it, kokoro takes what it is given.
int ThreadsFor(const Line& line)
{
	int n = 0;
	if (line.threads > 0)
		n = line.threads > 16 ? 16 : line.threads;
	else if (HelperLink::AutoThreads() > 0)
		n = HelperLink::AutoThreads();
	else
		n = line.engine == kEngineKokoro ? 2 : 0;
	const int cap = g.threadCap;
	return (n > 0 && cap > 0 && n > cap) ? cap : n;
}
} // namespace

// ---- the interface (h9_tts_kokoro.h) ------------------------------------------------------------------------------------

bool Init(int outRate)
{
	std::lock_guard<std::mutex> lock(g.mtx);
	if (g.inited)
		return g.dataOk;
	g.inited = true;
	g.outRate = outRate > 8000 ? outRate : 22050;
	g.dataOk = false;
	g.usable = false;

	if (!FindDataDir(g.dir))
	{
		SetReason("no h9tts folder next to the client library (ts\\h9tts\\voices.txt)");
		return false;
	}
	std::string text;
	if (!ReadFileW(g.dir + L"\\voices.txt", text, 1 << 20))
	{
		SetReason("cannot read h9tts\\voices.txt");
		return false;
	}
	g.catalogueCrc = Crc32(text.data(), text.size());
	std::string err;
	if (!h9fx::ParseCatalogue(text, g.cat, err))
	{
		SetReason(("h9tts\\voices.txt: " + err).c_str());
		return false;
	}
	if (!ReadFileW(g.dir + L"\\chains.txt", text, 1 << 20) || !h9fx::ParseChains(text, g.chains))
	{
		SetReason("cannot read h9tts\\chains.txt, or it holds no chain");
		return false;
	}
	if (!h9fx::CheckChains(g.cat, g.chains, err))
	{
		SetReason(("h9tts: " + err).c_str());
		return false;
	}
	g.dataOk = true;

	// the line pack and the helper are optional
	FILE* f = _wfopen((g.dir + L"\\lines\\lines.h9pk").c_str(), L"rb");
	if (f)
	{
		if (g.pack.Attach(f, &err))
			g.packLines = g.pack.Count();
	}
	g.helperFiles = FileExists(g.dir + L"\\bin\\h9kokoro64.exe") && FileExists(g.dir + L"\\manifest.txt");
	g.link.Configure(g.dir, g.catalogueCrc);
	g.usable = g.packLines > 0 || g.helperFiles;
	if (!g.usable)
		SetReason("neither a line pack nor the helper (bin\\h9kokoro64.exe with manifest.txt) is in the h9tts folder");
	return true;
}

void Shutdown()
{
	g.link.Shutdown();
	std::lock_guard<std::mutex> lock(g.mtx);
	g.usable = false;
	g.pack.Close();
	g.dataOk = false;
	g.inited = false;
}

bool Usable()
{
	return g.usable;
}

void Start(int threads)
{
	if (!g.usable || !g.helperFiles)
		return;
	int want = threads > 0 ? threads : HelperLink::AutoThreads();
	if (want <= 0)
		return;
	const int cap = g.threadCap;
	if (cap > 0 && want > cap)
		want = cap;
	// a thread count the player changed, or the frame-time watch lowered: the helper starts again with it
	const int now = g.link.ThreadsNow();
	if (now != 0 && now != want && !g.helperBusy)
		g.link.Reload(want);
	else
		g.link.Ensure(want);
	// a helper nobody has used for a long time is let go of; the next line starts it again
	const unsigned last = g.lastLine;
	if (last && g.link.GetState() == HelperLink::kReady && (unsigned)(GetTickCount() - last) > kIdleStopMs)
	{
		g.link.Stop();
		g.lastLine = 0;
	}
}

void Reload()
{
	g.threadCap = 0;
	g.lateRun = 0;
	g.restUntil = 0;
	if (g.usable && g.helperFiles)
		g.link.Reload(0);
}

void Frame(double dt)
{
	if (!g.usable || !g.helperFiles)
		return;
	g.link.Watch();
	if (g.watch.Frame(dt, g.helperBusy))
	{
		// the game's frames got longer while the helper worked, three lines of the last five: one thread fewer, not fewer than two
		const int now = g.link.ThreadsNow();
		if (now > 2)
			g.threadCap = now - 1;
	}
}

bool HelperReady()
{
	return g.link.GetState() == HelperLink::kReady;
}

int Describe(char* out, int size)
{
	if (!out || size < 2)
		return 0;
	std::lock_guard<std::mutex> lock(g.mtx);
	int n = 0;
	if (!g.dataOk)
		n += snprintf(out + n, (size_t)(size - n), "kokoro: not usable (%s)\n", g.reason.empty() ? "not started" : g.reason.c_str());
	else
	{
		n += snprintf(out + n, (size_t)(size - n), "kokoro: data ok, %d voice variants, %d chains, %d lines in the pack%s\n",
			(int)(g.cat.byKind[0].size() + g.cat.byKind[1].size() + g.cat.byKind[2].size() + g.cat.byKind[3].size() + g.cat.byKind[4].size()),
			(int)g.chains.chain.size(), (int)g.packLines, g.usable ? "" : " (nothing to speak with)");
		if (!g.helperFiles)
			n += snprintf(out + n, (size_t)(size - n), "kokoro helper: not installed (bin\\h9kokoro64.exe and manifest.txt)\n");
		else
		{
			const HelperLink::Status st = g.link.Describe();
			static const char* names[4] = { "off", "starting", "ready", "failed" };
			n += snprintf(out + n, (size_t)(size - n), "kokoro helper: %s (%s), %d thread(s), model loaded in %d ms, ONNX Runtime %d.%d, started %d time(s), %d failure(s) in a row%s\n",
				names[st.state], st.reason.c_str(), st.threads, st.loadMs, st.ortMajorMinor >> 8, st.ortMajorMinor & 255, st.starts, st.failures,
				st.givenUp ? ", GIVEN UP" : "");
			n += snprintf(out + n, (size_t)(size - n), "kokoro frame watch: baseline %.2f ms a frame, the last line %.0f percent of it, %d of the last lines slow, thread cap %s, lowered %d time(s)\n",
				g.watch.BaselineMs(), g.watch.LastRatio() * 100.0, g.watch.SlowInHistory(), g.threadCap > 0 ? std::to_string(g.threadCap.load()).c_str() : "none", g.watch.Decisions());
			n += snprintf(out + n, (size_t)(size - n), "kokoro lines: %d spoken (%d from the pack, %d from the helper, %d of those from its cache), %d the system voice had to take "
				"(%d waited too long for the speech thread, %d came late from the helper, %d refused as too busy, %d not asked while the helper rested; a line must start within %d ms), and %d more were given to the system voice while the helper made another line; "
				"last helper line: first piece after %d ms (%d ms to the mixer), %d ms in all%s\n",
				g.spoken.load(), g.fromPack.load(), g.fromHelper.load(), st.cacheHits, g.unavailable.load(), g.waitedTooLong.load(), g.late.load(), g.busy.load(), g.resting.load(),
				kStartBudgetMs, g.servedBySystem.load(), st.lastFirstMs, g.lastToSinkMs.load(), st.lastTotalMs,
				(g.restUntil && (int)(GetTickCount() - g.restUntil) < 0) ? "; THE HELPER IS RESTING (it was late with 3 lines in a row; cl_h9_tts_reload ends the rest)" : "");
		}
	}
	if (n < 0 || n >= size)
		n = size - 1;
	out[n] = 0;
	return n;
}

void NoteSystemVoice()
{
	g.servedBySystem++;
}

bool InPack(const Line& line)
{
	if (!g.usable || !line.text || !line.text[0])
		return false;
	const h9fx::Variant* v = g.cat.Pick(KindOf(line), line.variant);
	std::vector<int16_t> raw;
	return v && g.pack.Find(h9fx::VoiceKey(*v), line.text, raw);
}

Outcome Speak(const Line& line, Sink& sink)
{
	if (!g.usable || !line.text || !line.text[0])
		return kUnavailable;
	const h9fx::Variant* v = g.cat.Pick(KindOf(line), line.variant);
	if (!v)
		return kUnavailable;
	g.lastEngine = line.engine;

	// a line known ahead of time
	std::vector<int16_t> raw;
	if (g.pack.Find(h9fx::VoiceKey(*v), line.text, raw))
	{
		const bool ok = PlayPiece(raw.data(), (int)raw.size(), *v, line, sink, true, true);
		if (ok)
		{
			g.spoken++;
			g.fromPack++;
			g.lastLine = GetTickCount();
			return kSpoken;
		}
		return kFailed;
	}

	if (line.packOnly)
		return kUnavailable;

	// a line for the helper, if it is up
	if (!g.helperFiles)
	{
		g.unavailable++;
		return kUnavailable;
	}
	const int threads = ThreadsFor(line);
	if (threads <= 0)
	{
		g.unavailable++;
		return kUnavailable;
	}
	g.link.Ensure(threads); // a line before the server asked: it starts now, and this line is the system voice's
	if (g.link.GetState() != HelperLink::kReady)
	{
		g.unavailable++;
		return kUnavailable;
	}
	if (g.restUntil && (int)(GetTickCount() - g.restUntil) < 0)
	{
		g.unavailable++;
		g.resting++;
		return kUnavailable;
	}
	// what is left of the time the line may take to start, counted from its arrival
	const int budget = line.budgetMs > 0 ? line.budgetMs : kStartBudgetMs;
	const int left = budget - (line.arrived ? (int)(GetTickCount() - line.arrived) : 0);
	if (left < kMinStartMs)
	{
		g.unavailable++;
		g.waitedTooLong++;
		return kUnavailable;
	}
	g.lastLine = GetTickCount();

	bool anyPiece = false, streamOpen = false;
	const DWORD t0 = GetTickCount();
	g.helperBusy = true;
	const HelperLink::Result r = g.link.Synthesize(v->kind, v->index, true, line.text, (unsigned)(left - kSystemRenderMs),
		[&](const HelperLink::Piece& p) {
			if (PlayPiece(p.pcm, p.samples, *v, line, sink, p.first, p.last))
			{
				if (!anyPiece)
					g.lastToSinkMs = (int)(GetTickCount() - t0);
				anyPiece = true;
				streamOpen = !p.last;
			}
		},
		[&]() {
			sink.Idle();
			return sink.Cancelled();
		});
	g.helperBusy = false;
	if (streamOpen)
		sink.Chunk(nullptr, 0, false, true); // the line ended early: its voice must not wait for pieces that will not come
	if (anyPiece)
	{
		g.spoken++;
		g.fromHelper++;
		g.lateRun = 0;
		return r == HelperLink::kCancelled ? kCancelled : kSpoken;
	}
	if (r == HelperLink::kCancelled)
		return kCancelled;
	g.unavailable++;
	if (r == HelperLink::kLate)
	{
		g.late++;
		if (++g.lateRun >= kLateRunMax)
		{
			g.lateRun = 0;
			g.restUntil = GetTickCount() + kRestMs;
		}
	}
	else if (r == HelperLink::kBusy)
		g.busy++;
	return r == HelperLink::kFailed ? kFailed : kUnavailable;
}
} // namespace kokoro
} // namespace h9tts

#endif // H9TTS_HAVE_KOKORO
