// fake_helper -- a stand-in for h9kokoro64.exe that misbehaves on purpose, to test what the client does with a helper it cannot trust.
//
// It takes the same command line as the real helper (--serve --pipe <name> --parent <pid> --threads N) and the behaviour comes from the environment
// variable H9K_FAKE:
//   ok            answers every line with two good pieces and a DONE
//   garbage       sends bytes that are not a frame as soon as it is connected
//   wrongversion  READY with another protocol version
//   wrongcrc      READY with another catalogue checksum
//   hugelen       a frame head that announces more than kMaxPayload
//   unknowntype   a frame of a type the protocol does not have
//   wrongid       a piece of another line
//   wrongseq      the first piece is numbered 1
//   badrate       a piece at 8000 Hz
//   badsize       a piece whose sample count does not fit the frame
//   firstnotfirst the first piece without the first flag
//   nodone        two pieces and no DONE (the client must give up and stop it)
//   silent        never answers a line
//   crashmid      one piece, then the process ends
//   errordone     an ERROR frame and a DONE that says failed: a line that failed, a helper that did not
//   cancelaware   makes pieces slowly; answers DONE cancelled at a CANCEL
//   lateready     READY after 3 seconds
//   slowone       the first line is answered after 4 seconds (a CANCEL meanwhile is read late), every later line at once
//   busy          answers every line with DONE busy (the helper declines it)
//   noconnect     never connects to the pipe
//
// build: tools\h9kokoro64\tests\build_tests.bat (fake_helper.exe next to the others)

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "h9_tts_proto.h"

using namespace h9tts::proto;

static HANDLE g_pipe = INVALID_HANDLE_VALUE;
static HANDLE g_rev = nullptr, g_wev = nullptr;
bool g_slowDone = false;
static std::string g_mode;

static bool Io(bool read, void* buf, DWORD n, DWORD* done)
{
	OVERLAPPED ov;
	memset(&ov, 0, sizeof(ov));
	ov.hEvent = read ? g_rev : g_wev;
	ResetEvent(ov.hEvent);
	*done = 0;
	const BOOL ok = read ? ReadFile(g_pipe, buf, n, nullptr, &ov) : WriteFile(g_pipe, buf, n, nullptr, &ov);
	if (!ok && GetLastError() != ERROR_IO_PENDING)
		return false;
	return GetOverlappedResult(g_pipe, &ov, done, TRUE) != FALSE;
}

static bool ReadFull(void* buf, size_t n)
{
	uint8_t* p = (uint8_t*)buf;
	while (n > 0)
	{
		DWORD got = 0;
		if (!Io(true, p, (DWORD)n, &got) || got == 0)
			return false;
		p += got;
		n -= got;
	}
	return true;
}

static bool WriteAll(const void* buf, size_t n)
{
	const uint8_t* p = (const uint8_t*)buf;
	while (n > 0)
	{
		DWORD wrote = 0;
		if (!Io(false, (void*)p, (DWORD)(n > 65536 ? 65536 : n), &wrote) || wrote == 0)
			return false;
		p += wrote;
		n -= wrote;
	}
	return true;
}

static bool Send(uint32_t type, const std::vector<uint8_t>& payload)
{
	std::vector<uint8_t> f(kHeadSize + payload.size());
	MakeHead(f.data(), type, (uint32_t)payload.size());
	if (!payload.empty())
		memcpy(&f[kHeadSize], payload.data(), payload.size());
	return WriteAll(f.data(), f.size());
}

static void Put32v(std::vector<uint8_t>& v, uint32_t x)
{
	for (int i = 0; i < 4; i++)
		v.push_back((uint8_t)(x >> (8 * i)));
}

static void Put16v(std::vector<uint8_t>& v, uint32_t x)
{
	v.push_back((uint8_t)x);
	v.push_back((uint8_t)(x >> 8));
}

static bool SendReady(uint32_t version, uint32_t crc)
{
	std::vector<uint8_t> p;
	Put32v(p, version);
	Put32v(p, 1);
	Put32v(p, 2);
	Put32v(p, 100);
	Put32v(p, crc);
	Put32v(p, (1 << 8) | 31);
	Put32v(p, 0);
	return Send(kReady, p);
}

static bool SendChunk(uint32_t id, uint32_t seq, uint32_t flags, uint32_t rate, uint32_t samples, uint32_t declaredSamples)
{
	std::vector<uint8_t> p;
	Put32v(p, id);
	Put16v(p, seq);
	Put16v(p, flags);
	Put32v(p, rate);
	Put32v(p, declaredSamples);
	Put32v(p, 5);
	for (uint32_t i = 0; i < samples; i++)
		Put16v(p, (uint32_t)(uint16_t)(int16_t)(8000.0 * sin(0.1 * i)));
	return Send(kChunk, p);
}

static bool SendDone(uint32_t id, uint32_t status, uint32_t chunks)
{
	std::vector<uint8_t> p;
	Put32v(p, id);
	Put32v(p, status);
	Put32v(p, chunks);
	Put32v(p, 10);
	Put32v(p, 1);
	Put32v(p, 0);
	return Send(kDone, p);
}

int wmain(int argc, wchar_t** argv)
{
	std::wstring pipe;
	DWORD parent = 0;
	for (int i = 1; i < argc; i++)
	{
		if (!wcscmp(argv[i], L"--pipe") && i + 1 < argc)
			pipe = argv[++i];
		else if (!wcscmp(argv[i], L"--parent") && i + 1 < argc)
			parent = (DWORD)wcstoul(argv[++i], nullptr, 10);
	}
	char* m = getenv("H9K_FAKE");
	g_mode = m ? m : "ok";
	if (g_mode == "noconnect")
	{
		Sleep(60000);
		return 0;
	}
	if (parent)
	{
		HANDLE ph = OpenProcess(SYNCHRONIZE, FALSE, parent);
		if (ph)
		{
			CreateThread(nullptr, 0, [](LPVOID h) -> DWORD {
				WaitForSingleObject((HANDLE)h, INFINITE);
				ExitProcess(3);
			}, ph, 0, nullptr);
		}
	}
	for (int i = 0; i < 100 && g_pipe == INVALID_HANDLE_VALUE; i++)
	{
		g_pipe = CreateFileW(pipe.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
		if (g_pipe == INVALID_HANDLE_VALUE)
			Sleep(50);
	}
	if (g_pipe == INVALID_HANDLE_VALUE)
		return 4;
	g_rev = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	g_wev = CreateEventW(nullptr, TRUE, FALSE, nullptr);

	uint8_t head[kHeadSize];
	std::vector<uint8_t> payload;
	uint32_t crc = 0;
	bool first = true;
	for (;;)
	{
		if (!ReadFull(head, sizeof(head)))
			return 0;
		uint32_t type = 0, length = 0;
		if (!CheckHead(head, &type, &length))
			return 5;
		payload.resize(length);
		if (length && !ReadFull(payload.data(), length))
			return 0;
		if (type == kHello)
		{
			crc = Get32(&payload[16]);
			if (g_mode == "lateready")
				Sleep(3000);
			if (g_mode == "garbage")
			{
				const char junk[64] = "this is not a frame, this is just text that goes on and on....";
				WriteAll(junk, sizeof(junk));
				Sleep(500);
				continue;
			}
			if (g_mode == "wrongversion")
				SendReady(2, crc);
			else if (g_mode == "wrongcrc")
				SendReady(kVersion, crc ^ 1);
			else
				SendReady(kVersion, crc);
			continue;
		}
		if (type == kShutdown)
			return 0;
		if (type == kCancel && g_mode == "cancelaware")
		{
			SendDone(Get32(&payload[0]), kDoneCancelled, 0);
			continue;
		}
		if (type != kSynth)
			continue;
		const uint32_t id = Get32(&payload[0]);
		if (g_mode == "ok" || g_mode == "lateready")
		{
			SendChunk(id, 0, kChunkFirst, kSampleRate, 4800, 4800);
			SendChunk(id, 1, kChunkLast, kSampleRate, 4800, 4800);
			SendDone(id, kDoneOk, 2);
		}
		else if (g_mode == "slowone")
		{
			if (!g_slowDone)
			{
				g_slowDone = true;
				Sleep(4000);
			}
			SendChunk(id, 0, kChunkFirst, kSampleRate, 4800, 4800);
			SendChunk(id, 1, kChunkLast, kSampleRate, 4800, 4800);
			SendDone(id, kDoneOk, 2);
		}
		else if (g_mode == "busy")
		{
			SendDone(id, kDoneBusy, 0);
		}
		else if (g_mode == "hugelen")
		{
			uint8_t h[kHeadSize];
			MakeHead(h, kChunk, 0x7FFFFFFF);
			WriteAll(h, sizeof(h));
		}
		else if (g_mode == "unknowntype")
		{
			Send(99, std::vector<uint8_t>(8, 0));
		}
		else if (g_mode == "wrongid")
		{
			SendChunk(id + 1, 0, kChunkFirst | kChunkLast, kSampleRate, 4800, 4800);
			SendDone(id + 1, kDoneOk, 1);
		}
		else if (g_mode == "wrongseq")
		{
			SendChunk(id, 1, kChunkFirst, kSampleRate, 4800, 4800);
		}
		else if (g_mode == "badrate")
		{
			SendChunk(id, 0, kChunkFirst | kChunkLast, 8000, 4800, 4800);
		}
		else if (g_mode == "badsize")
		{
			SendChunk(id, 0, kChunkFirst | kChunkLast, kSampleRate, 4800, 9000);
		}
		else if (g_mode == "firstnotfirst")
		{
			SendChunk(id, 0, kChunkLast, kSampleRate, 4800, 4800);
		}
		else if (g_mode == "nodone")
		{
			SendChunk(id, 0, kChunkFirst, kSampleRate, 4800, 4800);
			SendChunk(id, 1, kChunkLast, kSampleRate, 4800, 4800);
		}
		else if (g_mode == "silent")
		{
		}
		else if (g_mode == "crashmid")
		{
			SendChunk(id, 0, kChunkFirst, kSampleRate, 4800, 4800);
			return 1;
		}
		else if (g_mode == "errordone")
		{
			std::vector<uint8_t> e;
			Put32v(e, id);
			Put32v(e, 6);
			const char* t = "no phonemes";
			e.insert(e.end(), t, t + strlen(t));
			Send(kError, e);
			SendDone(id, kDoneFailed, 0);
		}
		else if (g_mode == "cancelaware")
		{
			for (int i = 0; i < 15; i++)
				Sleep(100); // a long line: the client's CANCEL arrives meanwhile; the line ends when this does
			SendDone(id, kDoneCancelled, 0);
		}
		(void)first;
	}
}
