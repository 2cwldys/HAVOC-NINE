// kokoro_lab -- runs the client library's Kokoro code (reTS/cl_dll/h9_tts_kokoro.cpp and its link to the helper process) outside the game, 32-bit like
// the client, with a sink that collects what the mixer would be given. The tests under tools\h9tts\tests drive it.
//
// The lab finds its data the way the client does: <folder of the exe>\..\h9tts. Put the exe in <stage>\ts\cl_dlls and the data in <stage>\ts\h9tts.
//
//   kokoro_lab speak <kind> <variant> <depth> <muffle> <robot 0|1> <out.wav|-> <text...>
//   kokoro_lab matrix <outdir> <outrate> <text...>       every variant of every kind, with and without mask / machine sound, at three depths
//   kokoro_lab state
//   kokoro_lab lat <lines.txt> <kind> <variant> <threads> [repeat N] [gap MS] [budget MS] [nocache] [probe] [spin N]
//        the helper path end to end through the client code: every line of the file is spoken twice (the second time from the helper's cache), the time
//        to the first sound handed to the mixer and to the end is printed; with probe a thread that works like the game's main loop (60 Hz frames,
//        8 ms of work each) records its frame times while lines are made, with spin N busy threads at normal priority beside it; gap is the pause
//        between lines (5000), budget the time a line may take to start (the client's 3000; a large number measures the times without any line being given up),
//        nocache speaks each line once (not a second time from the helper's cache)
//   kokoro_lab burst <lines.txt> <kind> <variant> <threads> <count> <spacing MS> [from N] [budget MS]
//        lines that arrive spacing ms apart whether or not the one before has been made (the speech thread takes them one after the other): the time from
//        each line's arrival to its first sound, or the time at which the system voice would have been given it
//   kokoro_lab crash <kind> <variant> <threads>
//        speaks a line, ends the helper's process from outside in the middle of the next one, and checks that the line ends, that the state says why
//        and that the helper comes back by itself
//   kokoro_lab nohelper <text...>
//        a data folder with no helper: a line in the pack is spoken, any other is reported as not available
//
// kind is man, woman, mech, bot or droid. muffle 0 is no gas mask. The line is cleaned like the game cleans it.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <tlhelp32.h>

#include "h9_tts_kokoro.h"

using namespace h9tts::kokoro;

namespace
{
struct Collect : Sink
{
	std::vector<int16_t> pcm;
	int chunks = 0;
	void Chunk(const int16_t* p, int n, bool, bool) override
	{
		if (n > 0)
			pcm.insert(pcm.end(), p, p + n);
		chunks++;
	}
	bool Cancelled() override { return false; }
};

// A sink that notes when the first sound reaches it and when the last does.
struct Timed : Sink
{
	std::chrono::steady_clock::time_point t0, first, last;
	int chunks = 0;
	size_t frames = 0;
	double gapMs = 0;   // the time the speech would stand still between the pieces if it were played as they come
	double playEndMs = 0;
	void Chunk(const int16_t*, int n, bool, bool) override
	{
		const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
		if (n > 0 && chunks == 0)
			first = now;
		if (n > 0)
		{
			const double ready = std::chrono::duration<double, std::milli>(now - t0).count();
			if (chunks > 0 && ready > playEndMs)
				gapMs += ready - playEndMs;
			playEndMs = (ready > playEndMs ? ready : playEndMs) + n * 1000.0 / 22050.0;
			chunks++;
		}
		last = now;
		frames += (size_t)(n > 0 ? n : 0);
	}
	bool Cancelled() override { return false; }
	double FirstMs() const { return chunks ? std::chrono::duration<double, std::milli>(first - t0).count() : -1.0; }
	double LastMs() const { return chunks ? std::chrono::duration<double, std::milli>(last - t0).count() : -1.0; }
};

bool KindFrom(const char* s, Line& line)
{
	line.droid = false;
	if (!strcmp(s, "man"))
		line.voice = H9TTS_VOICE_MAN;
	else if (!strcmp(s, "woman"))
		line.voice = H9TTS_VOICE_WOMAN;
	else if (!strcmp(s, "mech"))
		line.voice = H9TTS_VOICE_MECH;
	else if (!strcmp(s, "bot"))
		line.voice = H9TTS_VOICE_BOT;
	else if (!strcmp(s, "droid"))
	{
		line.voice = H9TTS_VOICE_BOT;
		line.droid = true;
	}
	else
		return false;
	return true;
}

void WriteWav(const char* path, const std::vector<int16_t>& pcm, int rate)
{
	FILE* f = fopen(path, "wb");
	if (!f)
		return;
	const uint32_t bytes = (uint32_t)pcm.size() * 2;
	const uint32_t riff = 36 + bytes, fmt = 16, byteRate = (uint32_t)rate * 2, dataLen = bytes;
	const uint16_t tag = 1, ch = 1, align = 2, bits = 16;
	const uint32_t r = (uint32_t)rate;
	fwrite("RIFF", 1, 4, f);
	fwrite(&riff, 4, 1, f);
	fwrite("WAVEfmt ", 1, 8, f);
	fwrite(&fmt, 4, 1, f);
	fwrite(&tag, 2, 1, f);
	fwrite(&ch, 2, 1, f);
	fwrite(&r, 4, 1, f);
	fwrite(&byteRate, 4, 1, f);
	fwrite(&align, 2, 1, f);
	fwrite(&bits, 2, 1, f);
	fwrite("data", 1, 4, f);
	fwrite(&dataLen, 4, 1, f);
	fwrite(pcm.data(), 2, pcm.size(), f);
	fclose(f);
}

std::string Join(int argc, char** argv, int from)
{
	std::string t;
	for (int i = from; i < argc; i++)
	{
		if (!t.empty())
			t += ' ';
		t += argv[i];
	}
	return t;
}

// Waits for the helper to be ready. The game asks for it to be started every frame (Start), which also starts it again after a failed start once the pause is over; with threads
// above 0 this does the same.
bool WaitReady(int seconds, int threads = 0)
{
	for (int i = 0; i < seconds * 10; i++)
	{
		if (HelperReady())
			return true;
		if (threads > 0)
			Start(threads);
		Sleep(100);
	}
	return false;
}

// ---- speak and matrix ---------------------------------------------------------------------------------------------------------

int Speak1(int argc, char** argv)
{
	if (argc < 9)
		return 2;
	Line line;
	memset(&line, 0, sizeof(line));
	if (!KindFrom(argv[2], line))
		return 2;
	line.variant = atoi(argv[3]);
	line.depth = atoi(argv[4]);
	line.muffle = (float)atof(argv[5]);
	line.muffled = line.muffle > 0.0f;
	line.robot = atoi(argv[6]) != 0;
	line.engine = kEngineKokoro;
	const std::string text = Join(argc, argv, 8);
	line.text = text.c_str();
	if (!Init(22050))
	{
		char out[1024];
		Describe(out, sizeof(out));
		printf("init failed: %s", out);
		return 3;
	}
	Collect sink;
	const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
	const Outcome r = Speak(line, sink);
	const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
	printf("outcome %d  %u samples (%.2f s)  %d chunk(s)  %.1f ms\n", (int)r, (unsigned)sink.pcm.size(), sink.pcm.size() / 22050.0, sink.chunks, ms);
	if (r == kSpoken && strcmp(argv[7], "-"))
		WriteWav(argv[7], sink.pcm, 22050);
	Shutdown();
	return r == kSpoken ? 0 : 1;
}

// Every kind and variant of the catalogue, the settings that change the sound, one raw int16 file for each; cases.tsv lists them.
int Matrix(int argc, char** argv)
{
	if (argc < 5)
		return 2;
	const std::string dir = argv[2];
	const int rate = atoi(argv[3]);
	const std::string text = Join(argc, argv, 4);
	if (!Init(rate))
	{
		char out[1024];
		Describe(out, sizeof(out));
		printf("init failed: %s", out);
		return 3;
	}
	FILE* idx = fopen((dir + "\\cases.tsv").c_str(), "wb");
	if (!idx)
		return 3;
	const char* kinds[5] = { "man", "woman", "mech", "bot", "droid" };
	const int counts[5] = { 12, 12, 3, 3, 3 };
	const int depths[3] = { -10, 0, 7 };
	int n = 0, bad = 0;
	for (int k = 0; k < 5; k++)
	{
		for (int variant = 1; variant <= counts[k]; variant++)
		{
			for (int mode = 0; mode < 4; mode++)
			{
				const bool machine = k >= 2;
				// men and women: no mask, the mask at 0.5, 1 and 2; machines: the robot sound on and off (two modes left over are skipped)
				if (machine && mode > 1)
					continue;
				for (int d = 0; d < 3; d++)
				{
					Line line;
					memset(&line, 0, sizeof(line));
					KindFrom(kinds[k], line);
					line.variant = variant;
					line.depth = depths[d];
					line.engine = kEngineKokoro;
					line.robot = machine ? mode == 0 : true;
					line.muffled = !machine && mode > 0;
					line.muffle = machine ? 1.0f : (mode == 1 ? 0.5f : (mode == 2 ? 1.0f : 2.0f));
					line.text = text.c_str();
					Collect sink;
					const Outcome r = Speak(line, sink);
					if (r != kSpoken)
					{
						printf("case %s %d mode %d depth %d: outcome %d\n", kinds[k], variant, mode, depths[d], (int)r);
						bad++;
						continue;
					}
					char name[64];
					snprintf(name, sizeof(name), "c%04d.i16", n);
					FILE* f = fopen((dir + "\\" + name).c_str(), "wb");
					fwrite(sink.pcm.data(), 2, sink.pcm.size(), f);
					fclose(f);
					fprintf(idx, "%s\t%s\t%d\t%d\t%.2f\t%d\t%d\t%u\n", name, kinds[k], variant, line.muffled ? 1 : 0, line.muffle, line.robot ? 1 : 0, depths[d],
						(unsigned)sink.pcm.size());
					n++;
				}
			}
		}
	}
	fclose(idx);
	printf("%d cases written, %d failed\n", n, bad);
	Shutdown();
	return bad ? 1 : 0;
}

// ---- the helper -----------------------------------------------------------------------------------------------------------------

// A thread that does what the game's main loop does: frames of 16.7 ms with some work in each, its own times recorded.
struct Probe
{
	std::atomic<bool> stop, active;
	std::vector<double> idle, busy;
	std::thread th;
	int workMs;
	Probe() : stop(false), active(false), workMs(8) {}
	static double Now()
	{
		LARGE_INTEGER f, c;
		QueryPerformanceFrequency(&f);
		QueryPerformanceCounter(&c);
		return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
	}
	void Start()
	{
		th = std::thread([this]() {
			timeBeginPeriod(1);
			double prev = Now();
			while (!stop)
			{
				const double t = Now();
				while (Now() - t < workMs)
				{
				}
				const double next = t + 1000.0 / 60.0;
				while (Now() < next)
					Sleep(1);
				const double now = Now();
				(active ? busy : idle).push_back(now - prev);
				prev = now;
			}
			timeEndPeriod(1);
		});
	}
	void Stop()
	{
		stop = true;
		if (th.joinable())
			th.join();
	}
	static void Report(const char* name, std::vector<double>& v)
	{
		if (v.size() < 5)
		{
			printf("  %-8s too few frames (%u)\n", name, (unsigned)v.size());
			return;
		}
		std::sort(v.begin(), v.end());
		double sum = 0;
		int missed = 0;
		for (size_t i = 0; i < v.size(); i++)
		{
			sum += v[i];
			if (v[i] > 20.0)
				missed++;
		}
		printf("  %-8s %5u frames  mean %.2f ms  p95 %.2f ms  p99 %.2f ms  max %.2f ms  over 20 ms: %d (%.1f percent)\n", name, (unsigned)v.size(), sum / v.size(),
			v[v.size() * 95 / 100], v[v.size() * 99 / 100], v.back(), missed, 100.0 * missed / v.size());
	}
};

// The share of the whole machine that was busy between two samples (all processors, every process).
struct CpuSample
{
	ULONGLONG idle = 0, kernel = 0, user = 0;
	static CpuSample Take()
	{
		FILETIME i, k, u;
		GetSystemTimes(&i, &k, &u);
		CpuSample c;
		c.idle = ((ULONGLONG)i.dwHighDateTime << 32) | i.dwLowDateTime;
		c.kernel = ((ULONGLONG)k.dwHighDateTime << 32) | k.dwLowDateTime;
		c.user = ((ULONGLONG)u.dwHighDateTime << 32) | u.dwLowDateTime;
		return c;
	}
	// kernel time includes the idle time
	static double BusyPercent(const CpuSample& a, const CpuSample& b)
	{
		const double total = (double)((b.kernel - a.kernel) + (b.user - a.user));
		const double idle = (double)(b.idle - a.idle);
		return total > 0 ? 100.0 * (total - idle) / total : 0.0;
	}
};

std::vector<std::string> ReadLines(const char* path)
{
	std::vector<std::string> lines;
	FILE* f = fopen(path, "rb");
	if (!f)
		return lines;
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
	return lines;
}

int Lat(int argc, char** argv)
{
	if (argc < 6)
		return 2;
	const std::vector<std::string> lines = ReadLines(argv[2]);
	Line base;
	memset(&base, 0, sizeof(base));
	if (!KindFrom(argv[3], base))
		return 2;
	base.variant = atoi(argv[4]);
	const int threads = atoi(argv[5]);
	int repeat = 1, spin = 0, gap = 5000, budget = 0;
	bool probe = false, nocache = false;
	for (int i = 6; i < argc; i++)
	{
		if (!strcmp(argv[i], "repeat") && i + 1 < argc)
			repeat = atoi(argv[++i]);
		else if (!strcmp(argv[i], "budget") && i + 1 < argc)
			budget = atoi(argv[++i]);
		else if (!strcmp(argv[i], "gap") && i + 1 < argc)
			gap = atoi(argv[++i]);
		else if (!strcmp(argv[i], "probe"))
			probe = true;
		else if (!strcmp(argv[i], "nocache"))
			nocache = true;
		else if (!strcmp(argv[i], "spin") && i + 1 < argc)
			spin = atoi(argv[++i]);
	}
	base.engine = kEngineKokoro;
	base.threads = threads;
	base.budgetMs = budget;
	if (!Init(22050))
	{
		printf("init failed\n");
		return 3;
	}
	const std::chrono::steady_clock::time_point s0 = std::chrono::steady_clock::now();
	Start(threads);
	if (!WaitReady(90, threads))
	{
		char out[2048];
		Describe(out, sizeof(out));
		printf("the helper did not become ready:\n%s", out);
		return 4;
	}
	printf("helper ready after %.0f ms, %d thread(s)\n", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - s0).count(), threads);
	std::atomic<bool> spinStop(false);
	std::vector<std::thread> spinners;
	for (int i = 0; i < spin; i++)
	{
		spinners.push_back(std::thread([&spinStop]() {
			volatile double x = 1.0;
			while (!spinStop)
				x = x * 1.0000001 + 0.0000001;
		}));
	}
	Probe pr;
	if (probe)
		pr.Start();
	// one line to warm the model and the caches
	{
		Line w = base;
		w.text = "Ready.";
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		Speak(w, t);
	}
	Sleep(1200);
	{
		const CpuSample a = CpuSample::Take();
		Sleep(3000);
		printf("the machine's own load with nothing of ours going: %.1f percent of all processors\n", CpuSample::BusyPercent(a, CpuSample::Take()));
	}
	printf("%-58s %5s %7s %9s %9s %7s %6s %7s %s\n", "line", "words", "audio s", "first ms", "total ms", "pieces", "cpu %", "gap ms", "source");
	for (int rep = 0; rep < repeat; rep++)
	{
		for (size_t i = 0; i < lines.size(); i++)
		{
			for (int again = 0; again < (nocache ? 1 : 2); again++)
			{
				Line l = base;
				l.text = lines[i].c_str();
				l.arrived = GetTickCount();
				Timed t;
				pr.active = true;
				const CpuSample c0 = CpuSample::Take();
				t.t0 = std::chrono::steady_clock::now();
				const Outcome r = Speak(l, t);
				const double cpu = CpuSample::BusyPercent(c0, CpuSample::Take());
				pr.active = false;
				int words = 1;
				for (size_t k = 0; k < lines[i].size(); k++)
					words += lines[i][k] == ' ' ? 1 : 0;
				printf("%-58s %5d %7.2f %9.0f %9.0f %7d %6.1f %7.0f %s%s\n", lines[i].substr(0, 58).c_str(), words, t.frames / 22050.0, t.FirstMs(), t.LastMs(), t.chunks, cpu, t.gapMs,
					again ? "second time (cache)" : "first time", r == kSpoken ? "" : " NOT SPOKEN (the system voice takes it)");
				fflush(stdout);
				// lines of chat come seconds apart: the same line again (from the helper's cache) follows at once, the next line after gap ms (the helper
				// makes no more than half of any ten seconds, so a pause shorter than its busy time is a burst and the helper holds its phrases back)
				Sleep(again || nocache ? (DWORD)gap : 300);
			}
		}
	}
	if (probe)
	{
		pr.Stop();
		printf("frame times of the game-like thread (60 Hz, %d ms of work a frame, %d extra busy thread(s)):\n", pr.workMs, spin);
		Probe::Report("idle", pr.idle);
		Probe::Report("speaking", pr.busy);
	}
	spinStop = true;
	for (size_t i = 0; i < spinners.size(); i++)
		spinners[i].join();
	char out[2048];
	Describe(out, sizeof(out));
	printf("%s", out);
	Shutdown();
	return 0;
}

// ---- lines that arrive while another is being made ------------------------------------------------------------------------------

int Burst(int argc, char** argv)
{
	if (argc < 8)
		return 2;
	const std::vector<std::string> lines = ReadLines(argv[2]);
	Line base;
	memset(&base, 0, sizeof(base));
	if (lines.empty() || !KindFrom(argv[3], base))
		return 2;
	base.variant = atoi(argv[4]);
	const int threads = atoi(argv[5]);
	const int count = atoi(argv[6]);
	const int spacing = atoi(argv[7]);
	int from = 0, budget = 0;
	for (int i = 8; i < argc; i++)
	{
		if (!strcmp(argv[i], "from") && i + 1 < argc)
			from = atoi(argv[++i]);
		else if (!strcmp(argv[i], "budget") && i + 1 < argc)
			budget = atoi(argv[++i]);
	}
	base.engine = kEngineKokoro;
	base.threads = threads;
	base.budgetMs = budget;
	if (!Init(22050))
	{
		printf("init failed\n");
		return 3;
	}
	Start(threads);
	if (!WaitReady(90, threads))
	{
		printf("the helper did not become ready\n");
		return 4;
	}
	{
		Line w = base;
		w.text = "Ready.";
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		Speak(w, t);
	}
	Sleep(6000); // the helper's busy time of the warm-up line is out of its window
	printf("lines arrive %d ms apart, %d thread(s), start budget %d ms\n", spacing, threads, budget > 0 ? budget : kStartBudgetMs);
	printf("%3s %9s %5s %7s %12s %9s %7s  %s\n", "n", "arrives", "words", "audio s", "first (from arrival)", "total", "gap ms", "how");
	const std::chrono::steady_clock::time_point start = std::chrono::steady_clock::now();
	const DWORD startTick = GetTickCount();
	for (int i = 0; i < count; i++)
	{
		const double due = (double)i * spacing;
		const double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
		if (now < due)
			Sleep((DWORD)(due - now));
		const std::string& text = lines[(size_t)(from + i) % lines.size()];
		Line l = base;
		l.text = text.c_str();
		l.arrived = startTick + (DWORD)due;
		Timed t;
		t.t0 = start + std::chrono::milliseconds((long long)due);
		const Outcome r = Speak(l, t);
		const double back = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() - due;
		int words = 1;
		for (size_t k = 0; k < text.size(); k++)
			words += text[k] == ' ' ? 1 : 0;
		if (r == kSpoken)
			printf("%3d %9.0f %5d %7.2f %12.0f %9.0f %7.0f  Kokoro\n", i + 1, due, words, t.frames / 22050.0, t.FirstMs(), t.LastMs(), t.gapMs);
		else
			printf("%3d %9.0f %5d %7s %12.0f %9s %7s  SYSTEM VOICE (given up after %.0f ms; its own render, about 0.1 to 0.2 s, comes on top)\n", i + 1, due, words, "-", back, "-", "-", back);
		fflush(stdout);
	}
	char out[2048];
	Describe(out, sizeof(out));
	printf("%s", out);
	Shutdown();
	return 0;
}

// The helper's process, found by name among the lab's children, ended from outside: what the game would see if it crashed.
bool KillHelperFromOutside()
{
	const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
	if (snap == INVALID_HANDLE_VALUE)
		return false;
	PROCESSENTRY32W pe;
	pe.dwSize = sizeof(pe);
	bool killed = false;
	if (Process32FirstW(snap, &pe))
	{
		do
		{
			if (!_wcsicmp(pe.szExeFile, L"h9kokoro64.exe") && pe.th32ParentProcessID == GetCurrentProcessId())
			{
				const HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pe.th32ProcessID);
				if (h)
				{
					killed = TerminateProcess(h, 99) != FALSE;
					CloseHandle(h);
				}
			}
		} while (Process32NextW(snap, &pe));
	}
	CloseHandle(snap);
	return killed;
}

int Crash(int argc, char** argv)
{
	if (argc < 5)
		return 2;
	Line base;
	memset(&base, 0, sizeof(base));
	KindFrom(argv[2], base);
	base.variant = atoi(argv[3]);
	const int threads = atoi(argv[4]);
	base.engine = kEngineAuto;
	base.threads = threads;
	if (!Init(22050))
		return 3;
	Start(threads);
	if (!WaitReady(90, threads))
	{
		printf("FAIL: not ready\n");
		return 4;
	}
	int fails = 0;
	// 1 a line works
	{
		Line l = base;
		l.text = "this line comes from the helper";
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		const Outcome r = Speak(l, t);
		printf("1 a line: outcome %d, %d piece(s), first sound after %.0f ms\n", (int)r, t.chunks, t.FirstMs());
		fails += (r != kSpoken);
	}
	// 2 the helper is killed from outside while it makes a line
	{
		std::thread killer([]() {
			Sleep(350);
			printf("   (ending the helper's process from outside)\n");
			fflush(stdout);
			KillHelperFromOutside();
		});
		Line l = base;
		l.text = "a longer line so that the helper is still busy when it is ended, with a comma, and a second part after it";
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		const Outcome r = Speak(l, t);
		killer.join();
		char out[2048];
		Describe(out, sizeof(out));
		printf("2 a line while the helper dies: outcome %d, %d piece(s) delivered\n%s", (int)r, t.chunks, out);
		fails += (r == kSpoken && t.chunks == 0);
	}
	// 3 the line after that is the system voice's (not available), and the helper comes back by itself after its pause
	{
		Line l = base;
		l.text = "hello again";
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		const Outcome r = Speak(l, t);
		printf("3 the next line at once: outcome %d (not available is right while it restarts)\n", (int)r);
		fails += (r == kSpoken);
		bool back = false;
		for (int i = 0; i < 120 && !back; i++)
		{
			Start(threads);
			back = HelperReady();
			if (!back)
				Sleep(500);
		}
		printf("   the helper came back: %s\n", back ? "yes" : "NO");
		fails += !back;
		if (back)
		{
			Timed t2;
			t2.t0 = std::chrono::steady_clock::now();
			const Outcome r2 = Speak(l, t2);
			printf("4 a line after the restart: outcome %d, first sound after %.0f ms\n", (int)r2, t2.FirstMs());
			fails += (r2 != kSpoken);
		}
	}
	Shutdown();
	printf("crash test: %d failure(s)\n", fails);
	return fails ? 1 : 0;
}

// A sink for a line that is not wanted: it says so from the start, to test the cancel path.
struct CancelNow : Sink
{
	int chunks = 0;
	void Chunk(const int16_t*, int n, bool, bool) override
	{
		if (n > 0)
			chunks++;
	}
	bool Cancelled() override { return true; }
};

// One line against whatever program sits at bin\h9kokoro64.exe (the tests put a stand-in there that misbehaves): prints the outcome, the pieces
// and the helper's state so the driver can check them.  fakeline [cancel]
int FakeLine(int argc, char** argv)
{
	Line l;
	memset(&l, 0, sizeof(l));
	l.voice = H9TTS_VOICE_MAN;
	l.variant = 1;
	l.engine = kEngineAuto;
	l.threads = 2;
	l.text = "fake helper test line";
	if (!Init(22050))
	{
		printf("init failed\n");
		return 3;
	}
	Start(2);
	bool ready = false;
	for (int i = 0; i < 600 && !ready; i++)
	{
		ready = HelperReady();
		if (!ready)
		{
			char out[2048];
			Describe(out, sizeof(out));
			if (strstr(out, "helper: failed"))
				break;
			Sleep(100);
		}
	}
	printf("ready %d\n", ready ? 1 : 0);
	int outcome = -1, pieces = 0;
	if (ready)
	{
		if (argc > 2 && !strcmp(argv[2], "cancel"))
		{
			CancelNow s;
			outcome = (int)Speak(l, s);
			pieces = s.chunks;
		}
		else
		{
			Timed t;
			t.t0 = std::chrono::steady_clock::now();
			l.arrived = GetTickCount();
			outcome = (int)Speak(l, t);
			pieces = t.chunks;
		}
	}
	// a line given up as late: the link's watch ends a helper that does not answer the cancel, which the game's frames drive
	if (outcome == (int)kUnavailable)
	{
		for (int i = 0; i < 45; i++)
		{
			Frame(0.016);
			Sleep(100);
		}
	}
	char out[2048];
	Describe(out, sizeof(out));
	printf("outcome %d pieces %d\n%s", outcome, pieces, out);
	Shutdown();
	return 0;
}

// Three lines against the stand-in: the second right after the first, the third a few seconds after that. fakeseq prints the outcome and pieces of each.
int FakeSeq(int, char**)
{
	if (!Init(22050))
	{
		printf("init failed\n");
		return 3;
	}
	Start(2);
	bool ready = false;
	for (int i = 0; i < 600 && !ready; i++)
	{
		ready = HelperReady();
		if (!ready)
			Sleep(100);
	}
	printf("ready %d\n", ready ? 1 : 0);
	int outcome[3] = { -1, -1, -1 }, pieces[3] = { 0, 0, 0 };
	for (int k = 0; ready && k < 3; k++)
	{
		Line l;
		memset(&l, 0, sizeof(l));
		l.voice = H9TTS_VOICE_MAN;
		l.variant = 1;
		l.engine = kEngineAuto;
		l.threads = 2;
		l.text = "fake helper test line";
		l.arrived = GetTickCount();
		Timed t;
		t.t0 = std::chrono::steady_clock::now();
		outcome[k] = (int)Speak(l, t);
		pieces[k] = t.chunks;
		Sleep(k == 0 ? 100 : 3000);
	}
	char out[2048];
	Describe(out, sizeof(out));
	printf("seq %d %d %d pieces %d %d %d\n%s", outcome[0], outcome[1], outcome[2], pieces[0], pieces[1], pieces[2], out);
	Shutdown();
	return 0;
}

// Starts the helper, waits until it is ready, then does nothing for N seconds (a test ends this process from outside and looks at what became of the helper).
int Hold(int argc, char** argv)
{
	const int seconds = argc > 2 ? atoi(argv[2]) : 30;
	if (!Init(22050))
		return 3;
	Start(2);
	if (!WaitReady(90, 2))
	{
		printf("not ready\n");
		return 4;
	}
	printf("ready\n");
	fflush(stdout);
	Sleep((DWORD)seconds * 1000);
	Shutdown();
	return 0;
}

int NoHelper(int argc, char** argv)
{
	if (!Init(22050))
	{
		char out[1024];
		Describe(out, sizeof(out));
		printf("init: %s", out);
	}
	Line l;
	memset(&l, 0, sizeof(l));
	l.voice = H9TTS_VOICE_MAN;
	l.variant = 1;
	l.engine = kEngineAuto;
	const std::string text = Join(argc, argv, 2);
	l.text = text.c_str();
	Collect sink;
	const Outcome r = Speak(l, sink);
	printf("outcome %d (0 spoken, 1 not available), %u samples\n", (int)r, (unsigned)sink.pcm.size());
	char out[2048];
	Describe(out, sizeof(out));
	printf("%s", out);
	Shutdown();
	return 0;
}
} // namespace

int main(int argc, char** argv)
{
	if (argc >= 2 && !strcmp(argv[1], "speak"))
		return Speak1(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "matrix"))
		return Matrix(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "lat"))
		return Lat(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "burst"))
		return Burst(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "crash"))
		return Crash(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "nohelper"))
		return NoHelper(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "hold"))
		return Hold(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "fakeline"))
		return FakeLine(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "fakeseq"))
		return FakeSeq(argc, argv);
	if (argc >= 2 && !strcmp(argv[1], "state"))
	{
		Init(22050);
		char out[2048];
		Describe(out, sizeof(out));
		printf("%s", out);
		Shutdown();
		return 0;
	}
	fprintf(stderr, "usage: kokoro_lab speak|matrix|lat|burst|crash|nohelper|state ... (see the top of kokoro_lab.cpp)\n");
	return 1;
}
