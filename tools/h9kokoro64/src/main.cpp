// h9kokoro64 -- the Kokoro text-to-speech helper of the H9 client.
//
// The game's client library is 32-bit; a fast ONNX Runtime exists only for 64-bit, so the client starts this program and talks to it over a pipe.
// docs\TEXT_TO_SPEECH.txt (the Kokoro section) is the guide; reTS\cl_dll\h9_tts_proto.h the protocol.
//
//   h9kokoro64 --serve --pipe <name> [--parent <pid>] [--threads N] [--spin] [--data <folder>] [--dll <onnxruntime.dll>]
//        what the client starts: opens the named pipe and serves lines until the pipe breaks, the parent is gone or it is told to stop
//   h9kokoro64 --say <kind> <variant> <out.wav> <text...> [--threads N] [--no-stream]
//        makes one line, writes the raw trimmed audio as a 24 kHz WAV, prints the timing of each phrase
//   h9kokoro64 --bench <lines.txt> <kind> <variant> [--threads N] [--first N] [--later N] [--single N]
//        times every line of a file (time to the first phrase and to the end, per line, and the time the speech would stand still between its phrases
//        if it played as they come) and prints a table; --first, --later and --single set the phrase policy's targets (phonemes) to try others
//   h9kokoro64 --selftest [--data <folder>]
//        loads everything, makes a line, checks that there is speech in it; exit code 0 when all is well
//
// The data folder is the one above this program's folder (<data>\bin\h9kokoro64.exe), with voices.txt, chains.txt, g2p\, voices\ and model\.
// ONNX Runtime is bin\onnxruntime.dll beside the program. The process runs below normal priority, with no window and no crash dialog.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <chrono>
#include <string>
#include <vector>

#include "server.h"

using namespace h9k;

namespace
{
std::wstring Widen(const char* s)
{
	const int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
	std::wstring w((size_t)(n > 0 ? n - 1 : 0), L'\0');
	if (n > 1)
		MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
	return w;
}

std::string Narrow(const std::wstring& w)
{
	const int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	std::string s((size_t)(n > 0 ? n : 0), '\0');
	if (n > 0)
		WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
	return s;
}

LONG WINAPI Crashed(EXCEPTION_POINTERS* ep)
{
	fprintf(stderr, "h9kokoro64: unhandled exception 0x%08lx\n", ep && ep->ExceptionRecord ? ep->ExceptionRecord->ExceptionCode : 0);
	fflush(stderr);
	return EXCEPTION_EXECUTE_HANDLER;
}

std::wstring ExeDir()
{
	wchar_t path[1024];
	const DWORD n = GetModuleFileNameW(nullptr, path, 1024);
	std::wstring p(path, n);
	const size_t cut = p.find_last_of(L"\\/");
	return cut == std::wstring::npos ? L"." : p.substr(0, cut);
}

struct Options
{
	bool serve = false, selftest = false, spin = false, noStream = false;
	std::wstring pipe, data, dll;
	uint32_t parent = 0;
	int threads = 0;
	int first = 0, later = 0, single = 0; // the phrase policy's targets for the bench (0: as the server has them)
};

int DefaultThreads()
{
	// physical cores: half the logical ones when the machine has SMT; at least 2, at most 4 (the measured knee)
	SYSTEM_INFO si;
	GetSystemInfo(&si);
	int n = (int)si.dwNumberOfProcessors / 2;
	return n < 2 ? 2 : (n > 4 ? 4 : n);
}

bool Load(Engine& eng, const Options& o, std::string* err)
{
	const std::wstring dir = ExeDir();
	const std::wstring data = o.data.empty() ? dir + L"\\.." : o.data;
	const std::wstring dll = o.dll.empty() ? dir + L"\\onnxruntime.dll" : o.dll;
	return eng.Init(data, dll, o.threads > 0 ? (o.threads > Server::kMaxThreads ? Server::kMaxThreads : o.threads) : DefaultThreads(), o.spin, err);
}

void WriteWav(const char* path, const std::vector<int16_t>& pcm)
{
	FILE* f = fopen(path, "wb");
	if (!f)
		return;
	const uint32_t bytes = (uint32_t)pcm.size() * 2, riff = 36 + bytes, fmt = 16, rate = 24000, byteRate = 48000;
	const uint16_t tag = 1, ch = 1, align = 2, bits = 16;
	fwrite("RIFF", 1, 4, f);
	fwrite(&riff, 4, 1, f);
	fwrite("WAVEfmt ", 1, 8, f);
	fwrite(&fmt, 4, 1, f);
	fwrite(&tag, 2, 1, f);
	fwrite(&ch, 2, 1, f);
	fwrite(&rate, 4, 1, f);
	fwrite(&byteRate, 4, 1, f);
	fwrite(&align, 2, 1, f);
	fwrite(&bits, 2, 1, f);
	fwrite("data", 1, 4, f);
	fwrite(&bytes, 4, 1, f);
	fwrite(pcm.data(), 2, pcm.size(), f);
	fclose(f);
}

int KindFrom(const char* s)
{
	static const char* names[5] = { "man", "woman", "mech", "bot", "droid" };
	for (int i = 0; i < 5; i++)
	{
		if (!strcmp(s, names[i]))
			return i;
	}
	return -1;
}

double Ms(const std::chrono::steady_clock::time_point& a, const std::chrono::steady_clock::time_point& b)
{
	return std::chrono::duration<double, std::milli>(b - a).count();
}

// Makes a line the way the server does and reports. Returns the samples (all phrases) and the times.
struct LineTimes
{
	double g2pMs = 0, firstMs = 0, totalMs = 0, audioS = 0, gapMs = 0, cpuMs = 0;
	int phrases = 0;
};

// The CPU time this process has used so far (kernel and user), in milliseconds.
double ProcessCpuMs()
{
	FILETIME created, exited, kernel, user;
	if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user))
		return 0.0;
	const unsigned long long k = ((unsigned long long)kernel.dwHighDateTime << 32) | kernel.dwLowDateTime;
	const unsigned long long u = ((unsigned long long)user.dwHighDateTime << 32) | user.dwLowDateTime;
	return (double)(k + u) / 10000.0;
}

bool MakeLine(Engine& eng, const h9fx::Variant& v, const std::string& text, bool stream, std::vector<int16_t>& all, LineTimes& t, bool verbose, const PhrasePolicy& pol = PhrasePolicy())
{
	std::vector<Phrase> phrases;
	int g2pUs = 0;
	const double cpu0 = ProcessCpuMs();
	const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
	if (!eng.PlanLine(text, stream, pol, phrases, &g2pUs))
		return false;
	t.g2pMs = g2pUs / 1000.0;
	t.phrases = (int)phrases.size();
	all.clear();
	double playEndMs = 0; // when what has been made so far would stop sounding, if it were played as it comes (ms since the start)
	for (size_t i = 0; i < phrases.size(); i++)
	{
		std::vector<int16_t> pcm;
		int synthMs = 0;
		std::string err;
		Phrase ph = phrases[i];
		if (i + 1 == phrases.size())
			ph.pauseMs = 0;
		if (!eng.SynthPhrase(v, ph, pcm, &synthMs, &err))
		{
			printf("synthesis failed: %s\n", err.c_str());
			return false;
		}
		const double readyMs = Ms(t0, std::chrono::steady_clock::now());
		if (i == 0)
			t.firstMs = readyMs;
		else if (readyMs > playEndMs)
			t.gapMs += readyMs - playEndMs;
		playEndMs = (readyMs > playEndMs ? readyMs : playEndMs) + pcm.size() * 1000.0 / 24000.0;
		if (verbose)
			printf("  phrase %u: %u phonemes, %d ms of model, %.2f s of audio, %.0f ms since the start\n", (unsigned)i, (unsigned)ph.ps.size(), synthMs,
				pcm.size() / 24000.0, Ms(t0, std::chrono::steady_clock::now()));
		all.insert(all.end(), pcm.begin(), pcm.end());
	}
	t.totalMs = Ms(t0, std::chrono::steady_clock::now());
	t.cpuMs = ProcessCpuMs() - cpu0;
	t.audioS = all.size() / 24000.0;
	return true;
}
} // namespace

int wmain(int argc, wchar_t** argv)
{
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
	SetUnhandledExceptionFilter(Crashed);
	SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);

	Options o;
	std::vector<std::wstring> rest;
	std::wstring mode;
	for (int i = 1; i < argc; i++)
	{
		const std::wstring a = argv[i];
		if (a == L"--serve")
			o.serve = true;
		else if (a == L"--selftest")
			o.selftest = true;
		else if (a == L"--spin")
			o.spin = true;
		else if (a == L"--no-stream")
			o.noStream = true;
		else if (a == L"--pipe" && i + 1 < argc)
			o.pipe = argv[++i];
		else if (a == L"--parent" && i + 1 < argc)
			o.parent = (uint32_t)wcstoul(argv[++i], nullptr, 10);
		else if (a == L"--threads" && i + 1 < argc)
			o.threads = _wtoi(argv[++i]);
		else if (a == L"--first" && i + 1 < argc)
			o.first = _wtoi(argv[++i]);
		else if (a == L"--later" && i + 1 < argc)
			o.later = _wtoi(argv[++i]);
		else if (a == L"--single" && i + 1 < argc)
			o.single = _wtoi(argv[++i]);
		else if (a == L"--data" && i + 1 < argc)
			o.data = argv[++i];
		else if (a == L"--dll" && i + 1 < argc)
			o.dll = argv[++i];
		else if (a == L"--say" || a == L"--bench")
			mode = a;
		else
			rest.push_back(a);
	}

	Engine eng;
	std::string err;

	if (o.serve)
	{
		if (o.pipe.empty())
		{
			fprintf(stderr, "--serve needs --pipe <name>\n");
			return 2;
		}
		if (!Load(eng, o, &err))
		{
			fprintf(stderr, "h9kokoro64: %s\n", err.c_str());
			return 3;
		}
		PhrasePolicy pol;
		Server server(eng, pol);
		return server.Run(o.pipe, o.parent);
	}

	if (o.selftest)
	{
		if (!Load(eng, o, &err))
		{
			printf("selftest FAILED: %s\n", err.c_str());
			return 3;
		}
		std::vector<int16_t> pcm;
		LineTimes t;
		const h9fx::Variant* v = eng.VariantOf(0, 1);
		if (!v || !MakeLine(eng, *v, "Enemy spotted at the north gate. Get down!", true, pcm, t, true))
		{
			printf("selftest FAILED: no line\n");
			return 4;
		}
		double sum = 0;
		for (size_t i = 0; i < pcm.size(); i++)
			sum += (double)pcm[i] * pcm[i];
		const double rms = pcm.empty() ? 0 : sqrt(sum / pcm.size());
		printf("selftest: model %d ms, %d threads, ONNX Runtime %s, line %.2f s in %.0f ms (first phrase %.0f ms), rms %.0f\n", eng.LoadMs(), eng.Threads(),
			eng.OrtVersion().c_str(), t.audioS, t.totalMs, t.firstMs, rms);
		return (t.audioS > 1.0 && rms > 300.0) ? 0 : 5;
	}

	if ((mode == L"--say" && rest.size() >= 4) || (mode == L"--bench" && rest.size() >= 3))
	{
		const int kind = KindFrom(Narrow(rest[mode == L"--say" ? 0 : 1]).c_str());
		const int index = _wtoi(rest[mode == L"--say" ? 1 : 2].c_str());
		if (!Load(eng, o, &err))
		{
			fprintf(stderr, "h9kokoro64: %s\n", err.c_str());
			return 3;
		}
		const h9fx::Variant* v = eng.VariantOf(kind, index);
		if (!v)
		{
			fprintf(stderr, "no such voice: kind and variant number as the catalogue has them\n");
			return 2;
		}
		printf("loaded: model %d ms, %d threads, ONNX Runtime %s, voice %s %d (%s)\n", eng.LoadMs(), eng.Threads(), eng.OrtVersion().c_str(), Narrow(rest[mode == L"--say" ? 0 : 1]).c_str(),
			index, v->name.c_str());
		if (mode == L"--say")
		{
			std::string text;
			for (size_t i = 3; i < rest.size(); i++)
				text += (i > 3 ? " " : "") + Narrow(rest[i]);
			std::vector<int16_t> pcm;
			LineTimes t;
			if (!MakeLine(eng, *v, text, !o.noStream, pcm, t, true))
				return 4;
			printf("line: %.2f s of audio in %.0f ms (g2p %.1f ms, first phrase after %.0f ms, %d phrase(s))\n", t.audioS, t.totalMs, t.g2pMs, t.firstMs, t.phrases);
			WriteWav(Narrow(rest[2]).c_str(), pcm);
			return 0;
		}
		// --bench: every line of the file, twice (the second time is the model warm and the line cached by nothing: the helper's cache is the server's)
		FILE* f = _wfopen(rest[0].c_str(), L"rb");
		if (!f)
			return 2;
		std::vector<std::string> lines;
		std::string line;
		int c;
		for (;;)
		{
			line.clear();
			while ((c = fgetc(f)) != EOF && c != '\n')
				line += (char)c;
			if (c == EOF && line.empty())
				break;
			while (!line.empty() && (line.back() == '\r' || line.back() == ' '))
				line.pop_back();
			if (!line.empty())
				lines.push_back(line);
		}
		fclose(f);
		PhrasePolicy pol;
		if (o.first > 0)
			pol.firstTarget = o.first;
		if (o.later > 0)
			pol.laterTarget = o.later;
		if (o.single > 0)
			pol.singleMax = o.single;
		if (o.first > 0)
			pol.firstMax = o.first + 12;
		printf("policy: single %d, first %d (to %d), later %d (to %d), minimum %d phonemes\n", pol.singleMax, pol.firstTarget, pol.firstMax, pol.laterTarget, pol.maxPhrase, pol.minPhrase);
		printf("%-60s %6s %8s %8s %8s %6s %7s %7s\n", "line", "words", "audio s", "first ms", "total ms", "phr", "gap ms", "cores");
		for (size_t i = 0; i < lines.size(); i++)
		{
			std::vector<int16_t> pcm;
			LineTimes t;
			if (!MakeLine(eng, *v, lines[i], !o.noStream, pcm, t, false, pol))
			{
				printf("%-60s failed\n", lines[i].substr(0, 60).c_str());
				continue;
			}
			int words = 1;
			for (size_t k = 0; k < lines[i].size(); k++)
				words += lines[i][k] == ' ' ? 1 : 0;
			printf("%-60s %6d %8.2f %8.0f %8.0f %6d %7.0f %7.2f\n", lines[i].substr(0, 60).c_str(), words, t.audioS, t.firstMs, t.totalMs, t.phrases, t.gapMs,
				t.totalMs > 0 ? t.cpuMs / t.totalMs : 0.0);
			fflush(stdout);
		}
		return 0;
	}
	fprintf(stderr, "usage: h9kokoro64 --serve --pipe <name> | --say <kind> <variant> <out.wav> <text...> | --bench <lines.txt> <kind> <variant> | --selftest\n");
	return 2;
}
