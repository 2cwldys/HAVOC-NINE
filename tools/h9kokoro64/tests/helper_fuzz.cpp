// helper_fuzz -- the real helper (h9kokoro64.exe) against a client that sends it what it should not.
//
//   helper_fuzz <h9kokoro64.exe> <sessions> [seed]
//
// Plays the client's part (makes the pipe, starts the helper, says HELLO) and then, in each session, sends frames that are wrong in one way or another:
// bad magic, unknown types, sizes that do not fit the type, a payload cut short, a huge announced length, junk where a frame head should be, and frames
// that are valid but hold nonsense (voice kinds and numbers out of range, texts of random bytes, a flood of lines, cancels of lines that do not exist,
// a thread count of a million). After a frame the protocol accepts the helper must still answer a PING; after one it does not accept it must end
// (exit code 0 or 5) and never crash. Any other exit code (an access violation is 0xC0000005) or a hang is a failure.
//
// build: tools\h9kokoro64\tests\build_tests.bat

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "h9_tts_proto.h"

using namespace h9tts::proto;

static HANDLE g_pipe = INVALID_HANDLE_VALUE, g_proc = nullptr, g_rev = nullptr, g_wev = nullptr;
static uint32_t g_rng = 2463534242u;
static uint32_t Rnd()
{
	g_rng ^= g_rng << 13;
	g_rng ^= g_rng >> 17;
	g_rng ^= g_rng << 5;
	return g_rng;
}

static bool Io(bool read, void* buf, DWORD n, DWORD* done, DWORD timeoutMs)
{
	OVERLAPPED ov;
	memset(&ov, 0, sizeof(ov));
	ov.hEvent = read ? g_rev : g_wev;
	ResetEvent(ov.hEvent);
	*done = 0;
	const BOOL ok = read ? ReadFile(g_pipe, buf, n, nullptr, &ov) : WriteFile(g_pipe, buf, n, nullptr, &ov);
	if (!ok && GetLastError() != ERROR_IO_PENDING)
		return false;
	HANDLE waits[2] = { ov.hEvent, g_proc };
	const DWORD w = WaitForMultipleObjects(2, waits, FALSE, timeoutMs);
	if (w != WAIT_OBJECT_0)
	{
		CancelIoEx(g_pipe, &ov);
		GetOverlappedResult(g_pipe, &ov, done, TRUE);
		return false;
	}
	return GetOverlappedResult(g_pipe, &ov, done, FALSE) != FALSE;
}

static bool WriteAll(const void* buf, size_t n)
{
	const uint8_t* p = (const uint8_t*)buf;
	while (n > 0)
	{
		DWORD wrote = 0;
		if (!Io(false, (void*)p, (DWORD)(n > 65536 ? 65536 : n), &wrote, 5000) || wrote == 0)
			return false;
		p += wrote;
		n -= wrote;
	}
	return true;
}

static bool ReadAll(void* buf, size_t n, DWORD timeoutMs)
{
	uint8_t* p = (uint8_t*)buf;
	while (n > 0)
	{
		DWORD got = 0;
		if (!Io(true, p, (DWORD)(n > 65536 ? 65536 : n), &got, timeoutMs) || got == 0)
			return false;
		p += got;
		n -= got;
	}
	return true;
}

static bool SendFrame(uint32_t type, const std::vector<uint8_t>& payload)
{
	std::vector<uint8_t> f(kHeadSize + payload.size());
	MakeHead(f.data(), type, (uint32_t)payload.size());
	if (!payload.empty())
		memcpy(&f[kHeadSize], payload.data(), payload.size());
	return WriteAll(f.data(), f.size());
}

static void P32(std::vector<uint8_t>& v, uint32_t x)
{
	for (int i = 0; i < 4; i++)
		v.push_back((uint8_t)(x >> (8 * i)));
}

// Reads frames the helper sends until a given type arrives (or the timeout / an end); returns the type, or 0.
static uint32_t ReadUntil(uint32_t want, DWORD timeoutMs, std::vector<uint8_t>* payload = nullptr)
{
	const DWORD t0 = GetTickCount();
	for (;;)
	{
		uint8_t head[kHeadSize];
		const DWORD left = GetTickCount() - t0 >= timeoutMs ? 0 : timeoutMs - (GetTickCount() - t0);
		if (!ReadAll(head, sizeof(head), left))
			return 0;
		uint32_t type = 0, length = 0;
		if (!CheckHead(head, &type, &length))
			return 0;
		std::vector<uint8_t> p(length);
		if (length && !ReadAll(p.data(), length, 10000))
			return 0;
		if (type == want)
		{
			if (payload)
				*payload = p;
			return type;
		}
	}
}

static bool StartHelper(const std::wstring& exe)
{
	wchar_t name[96];
	_snwprintf(name, 96, L"\\\\.\\pipe\\h9fuzz-%lu-%lu", GetCurrentProcessId(), GetTickCount());
	g_pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 1 << 20, 1 << 20, 0, nullptr);
	if (g_pipe == INVALID_HANDLE_VALUE)
		return false;
	wchar_t cmd[1200];
	_snwprintf(cmd, 1200, L"\"%ls\" --serve --pipe %ls --parent %lu --threads 2", exe.c_str(), name, GetCurrentProcessId());
	STARTUPINFOW si;
	memset(&si, 0, sizeof(si));
	si.cb = sizeof(si);
	PROCESS_INFORMATION pi;
	memset(&pi, 0, sizeof(pi));
	if (!CreateProcessW(exe.c_str(), cmd, nullptr, nullptr, FALSE, CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS, nullptr, nullptr, &si, &pi))
		return false;
	CloseHandle(pi.hThread);
	g_proc = pi.hProcess;
	OVERLAPPED ov;
	memset(&ov, 0, sizeof(ov));
	ov.hEvent = g_rev;
	ResetEvent(ov.hEvent);
	if (!ConnectNamedPipe(g_pipe, &ov) && GetLastError() == ERROR_IO_PENDING)
	{
		HANDLE waits[2] = { ov.hEvent, g_proc };
		if (WaitForMultipleObjects(2, waits, FALSE, 15000) != WAIT_OBJECT_0)
			return false;
	}
	std::vector<uint8_t> hello;
	P32(hello, kVersion);
	P32(hello, GetCurrentProcessId());
	P32(hello, 2);
	P32(hello, 0);
	P32(hello, 0);
	if (!SendFrame(kHello, hello))
		return false;
	return ReadUntil(kReady, 60000) == kReady;
}

static void StopHelper()
{
	if (g_proc)
	{
		TerminateProcess(g_proc, 77);
		WaitForSingleObject(g_proc, 3000);
		CloseHandle(g_proc);
		g_proc = nullptr;
	}
	if (g_pipe != INVALID_HANDLE_VALUE)
		CloseHandle(g_pipe);
	g_pipe = INVALID_HANDLE_VALUE;
}

// ping and expect a pong (the helper is up and in step)
static bool Alive()
{
	static uint32_t token = 1000;
	std::vector<uint8_t> p;
	P32(p, ++token);
	if (!SendFrame(kPing, p))
		return false;
	// other pings of the fuzz may have been answered before this one: read answers until the one with this token
	const DWORD t0 = GetTickCount();
	while (GetTickCount() - t0 < 20000)
	{
		std::vector<uint8_t> pong;
		if (ReadUntil(kPong, 20000, &pong) != kPong || pong.size() != 20)
			return false;
		if (Get32(&pong[0]) == token)
			return true;
	}
	return false;
}

static DWORD ExitCodeWithin(DWORD ms)
{
	if (WaitForSingleObject(g_proc, ms) != WAIT_OBJECT_0)
		return STILL_ACTIVE;
	DWORD code = 0;
	GetExitCodeProcess(g_proc, &code);
	return code;
}

static std::vector<uint8_t> RandomBytes(size_t n)
{
	std::vector<uint8_t> v(n);
	for (size_t i = 0; i < n; i++)
		v[i] = (uint8_t)Rnd();
	return v;
}

static int g_fail = 0;
#define CHECK(c, ...)                                  \
	do                                                 \
	{                                                  \
		if (!(c))                                      \
		{                                              \
			printf("FAIL: ");                          \
			printf(__VA_ARGS__);                       \
			printf("\n");                              \
			g_fail++;                                  \
		}                                              \
	} while (0)

// a frame the protocol rejects: the helper must end, quietly
static void BadFrame(const char* what, const std::vector<uint8_t>& bytes, bool sendAll = true)
{
	if (!sendAll)
		return;
	WriteAll(bytes.data(), bytes.size());
	const DWORD code = ExitCodeWithin(8000);
	CHECK(code == 0 || code == 5, "%s: the helper's exit code is 0x%lx (still running: %d)", what, code, code == STILL_ACTIVE);
	printf("  %-34s -> exit code %lu\n", what, code);
}

int wmain(int argc, wchar_t** argv)
{
	if (argc < 3)
	{
		fprintf(stderr, "usage: helper_fuzz <h9kokoro64.exe> <sessions> [seed]\n");
		return 2;
	}
	const std::wstring exe = argv[1];
	const int sessions = _wtoi(argv[2]);
	if (argc > 3)
		g_rng = (uint32_t)_wtoi(argv[3]) | 1u;
	g_rev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	g_wev = CreateEventW(nullptr, TRUE, FALSE, nullptr);

	// ---- frames the protocol rejects, one per helper
	struct Case { const char* name; std::vector<uint8_t> bytes; };
	std::vector<Case> bad;
	{
		std::vector<uint8_t> f(kHeadSize + 4, 0);
		MakeHead(f.data(), kPing, 4);
		f[0] ^= 0xFF;
		bad.push_back({ "bad magic", f });
		MakeHead(f.data(), 99, 4);
		bad.push_back({ "unknown type", f });
		MakeHead(f.data(), kPing, 9);
		bad.push_back({ "ping of 9 bytes", f });
		std::vector<uint8_t> h(kHeadSize);
		MakeHead(h.data(), kSynth, 0x7FFFFFFF);
		bad.push_back({ "length 2 GB", h });
		MakeHead(h.data(), kSynth, kMaxPayload + 1);
		bad.push_back({ "length over the limit", h });
		MakeHead(h.data(), kSynth, 5);
		h.resize(kHeadSize + 5, 0);
		bad.push_back({ "synth of 5 bytes", h });
		std::vector<uint8_t> j = RandomBytes(40);
		bad.push_back({ "junk instead of a head", j });
		std::vector<uint8_t> r(kHeadSize + 8, 0);
		MakeHead(r.data(), kReady, 8);
		bad.push_back({ "a helper-to-client type", r });
	}
	for (size_t i = 0; i < bad.size() && (int)i < sessions; i++)
	{
		if (!StartHelper(exe))
		{
			printf("FAIL: the helper did not start\n");
			StopHelper();
			return 1;
		}
		BadFrame(bad[i].name, bad[i].bytes);
		StopHelper();
	}

	// ---- frames the protocol accepts, holding nonsense: the helper stays up
	if (!StartHelper(exe))
	{
		printf("FAIL: the helper did not start\n");
		return 1;
	}
	int sent = 0;
	for (int round = 0; round < sessions * 25; round++)
	{
		std::vector<uint8_t> p;
		switch (Rnd() % 9)
		{
		case 0: // a line with a voice that does not exist
			P32(p, Rnd());
			p.push_back((uint8_t)Rnd());
			p.push_back((uint8_t)Rnd());
			p.push_back((uint8_t)Rnd());
			p.push_back(0);
			{
				const uint32_t n = 1 + Rnd() % 40;
				P32(p, n);
				std::vector<uint8_t> t = RandomBytes(n);
				p.insert(p.end(), t.begin(), t.end());
			}
			SendFrame(kSynth, p);
			break;
		case 1: // a line whose text length does not match its frame
			P32(p, Rnd());
			p.push_back(0);
			p.push_back(1);
			p.push_back(0);
			p.push_back(0);
			P32(p, 500);
			p.push_back('h');
			p.push_back('i');
			SendFrame(kSynth, p);
			break;
		case 2: // a good voice, a text of random bytes (any code point, control characters, invalid UTF-8)
			P32(p, Rnd() | 1);
			p.push_back((uint8_t)(Rnd() % 5));
			p.push_back((uint8_t)(1 + Rnd() % 3));
			p.push_back((uint8_t)(Rnd() & 1));
			p.push_back(0);
			{
				const uint32_t n = 1 + Rnd() % 60;
				P32(p, n);
				std::vector<uint8_t> t = RandomBytes(n);
				p.insert(p.end(), t.begin(), t.end());
			}
			SendFrame(kSynth, p);
			sent++;
			break;
		case 3: // a good voice, a text of very long words and numbers
		{
			P32(p, Rnd() | 1);
			p.push_back(0);
			p.push_back(1);
			p.push_back(1);
			p.push_back(0);
			std::string t;
			const char* pieces[] = { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1234567890123456789012345678901234567890", "$99999999999999.99", "x_Y_z", "...", "?!", "U.S.A." };
			while (t.size() < 150)
				t += std::string(pieces[Rnd() % 7]) + " ";
			t.resize(150);
			P32(p, (uint32_t)t.size());
			p.insert(p.end(), t.begin(), t.end());
			SendFrame(kSynth, p);
			sent++;
			break;
		}
		case 4: // a cancel of a line that does not exist
			P32(p, Rnd());
			SendFrame(kCancel, p);
			break;
		case 5: // a thread count that is not one
			P32(p, (Rnd() & 1) ? 0 : 1000000);
			SendFrame(kSetThreads, p);
			break;
		case 6: // a repeated HELLO
			P32(p, kVersion);
			P32(p, GetCurrentProcessId());
			P32(p, Rnd() % 5);
			P32(p, 0);
			P32(p, 0);
			SendFrame(kHello, p);
			break;
		case 7: // a log or an error frame sent to the helper (types it never takes from a client are an error: but a valid head is checked first)
			P32(p, Rnd());
			SendFrame(kPing, p);
			break;
		default: // a flood: many lines at once, the queue pushes the old ones out
			for (int k = 0; k < 8; k++)
			{
				std::vector<uint8_t> q;
				P32(q, 5000 + (uint32_t)k);
				q.push_back(0);
				q.push_back(1);
				q.push_back(0);
				q.push_back(0);
				P32(q, 5);
				q.insert(q.end(), { 'h', 'e', 'l', 'l', 'o' });
				SendFrame(kSynth, q);
			}
			break;
		}
		if (round % 6 == 5)
		{
			// a pause in the traffic: the helper must be in step (a SET_THREADS makes it load a new session: allow it time)
			if (!Alive())
			{
				const DWORD code = ExitCodeWithin(100);
				CHECK(false, "no answer to a ping after round %d (exit code 0x%lx)", round, code);
				break;
			}
		}
	}
	const bool alive = Alive();
	CHECK(alive, "the helper is not answering after the nonsense");
	printf("  %d nonsense lines sent; the helper %s\n", sent, alive ? "still answers" : "does not answer");
	std::vector<uint8_t> none;
	SendFrame(kShutdown, none);
	const DWORD code = ExitCodeWithin(8000);
	CHECK(code == 0, "SHUTDOWN: exit code 0x%lx", code);
	printf("  SHUTDOWN -> exit code %lu\n", code);
	StopHelper();
	printf("helper_fuzz: %d failure(s)\n", g_fail);
	return g_fail ? 1 : 0;
}
