// ---- H9 text to speech: the link to the Kokoro helper process -------------------------------------------------------------------
// See h9_tts_kokoro_link.h.

#include "h9_tts_kokoro_link.h"

#if H9TTS_HAVE_KOKORO

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sddl.h>

#include <stdio.h>
#include <string.h>

#include "h9_tts_proto.h"
#include "h9_tts_sha256.h"

namespace h9tts
{
namespace kokoro
{
namespace
{
const unsigned kConnectMs = 30000;    // the helper opens the pipe within this long: it loads its model first (2 to 3 s; a cold disk or a busy machine more)
const unsigned kReadyMs = 45000;       // and has loaded its model and says READY within this long (a cold disk reads 92 MB)
const unsigned kFirstPieceMs = 9000;   // the first piece of a line comes within this long, when the caller names no time
const unsigned kNextPieceMs = 9000;    // each next piece, and the end
const unsigned kCancelDrainMs = 3000;  // after a CANCEL the helper answers within this long
const unsigned kDrainWaitMs = 150;     // a line that finds the answer to an earlier cancel still missing waits this long for it
const unsigned kWriteMs = 5000;
const int kAutoThreadsMax = 8;         // the threads the game gives the helper on a machine with that many logical processors or more
const int kMaxFailures = 5;            // in a row: then only cl_h9_tts_reload starts it again
const unsigned kRetryBaseMs = 4000;    // the pause after a failure doubles, to kRetryMaxMs
const unsigned kRetryMaxMs = 120000;
const size_t kMemoryLimit = 1536u << 20; // the helper's memory limit (its model and one line need about 400 MB)

enum { kReadOk = 0, kReadTimeout = 1, kReadError = 2 };

// The lines of h9tts\manifest.txt:  sha256 <64 hex> <relative path>   (// and # start a comment)
bool ManifestHash(const std::wstring& dir, const std::string& rel, std::string& hex)
{
	FILE* f = _wfopen((dir + L"\\manifest.txt").c_str(), L"rb");
	if (!f)
		return false;
	char line[512];
	bool found = false;
	while (fgets(line, sizeof(line), f))
	{
		char tag[16], digest[80], path[400];
		if (line[0] == '#' || (line[0] == '/' && line[1] == '/'))
			continue;
		if (sscanf(line, "%15s %79s %399s", tag, digest, path) == 3 && !strcmp(tag, "sha256") && rel == path && strlen(digest) == 64)
		{
			hex = digest;
			found = true;
			break;
		}
	}
	fclose(f);
	return found;
}

std::wstring Widen(const std::string& s)
{
	const int n = MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), nullptr, 0);
	std::wstring w((size_t)(n > 0 ? n : 0), L'\0');
	if (n > 0)
		MultiByteToWideChar(CP_ACP, 0, s.c_str(), (int)s.size(), &w[0], n);
	return w;
}
} // namespace

HelperLink::HelperLink()
{
	m_readEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	m_writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
}

HelperLink::~HelperLink()
{
	Shutdown();
	std::lock_guard<std::mutex> io(m_ioMtx);
	if (m_readEvent)
		CloseHandle((HANDLE)m_readEvent);
	if (m_writeEvent)
		CloseHandle((HANDLE)m_writeEvent);
	m_readEvent = m_writeEvent = nullptr;
}

// The helper is ended, the thread that was starting it is joined and the handles are closed. The link can be started again after it.
void HelperLink::Shutdown()
{
	Stop();
	std::thread* starter = nullptr;
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		starter = m_starter;
		m_starter = nullptr;
	}
	if (starter)
	{
		starter->join();
		delete starter;
	}
	std::lock_guard<std::mutex> io(m_ioMtx);
	if (m_pipe)
		CloseHandle((HANDLE)m_pipe);
	if (m_proc)
	{
		WaitForSingleObject((HANDLE)m_proc, 2000);
		CloseHandle((HANDLE)m_proc);
	}
	if (m_job)
		CloseHandle((HANDLE)m_job);
	m_pipe = m_proc = m_job = nullptr;
}

int HelperLink::ThreadsNow()
{
	std::lock_guard<std::mutex> lock(m_mtx);
	return m_status.state == kReady ? m_status.threads : 0;
}

void HelperLink::Configure(const std::wstring& dir, uint32_t catalogueCrc)
{
	std::lock_guard<std::mutex> lock(m_mtx);
	m_dir = dir;
	m_catalogueCrc = catalogueCrc;
}

int HelperLink::AutoThreads()
{
	SYSTEM_INFO si;
	GetSystemInfo(&si);
	if (si.dwNumberOfProcessors < 4)
		return 0;
	const int n = (int)si.dwNumberOfProcessors;
	return n > kAutoThreadsMax ? kAutoThreadsMax : n;
}

HelperLink::State HelperLink::GetState()
{
	std::lock_guard<std::mutex> lock(m_mtx);
	return m_status.state;
}

HelperLink::Status HelperLink::Describe()
{
	std::lock_guard<std::mutex> lock(m_mtx);
	return m_status;
}

void HelperLink::Ensure(int threads)
{
	std::lock_guard<std::mutex> lock(m_mtx);
	if (m_dir.empty() || m_status.givenUp)
		return;
	if (m_status.state == kStarting)
		return;
	if (m_status.state == kReady)
		return;
	if (m_status.state == kBroken && (int)(GetTickCount() - m_retryAt) < 0)
		return;
	if (m_starter)
	{
		m_starter->join();
		delete m_starter;
		m_starter = nullptr;
	}
	m_status.state = kStarting;
	m_status.reason = "starting";
	m_wantThreads = threads;
	m_starter = new std::thread(&HelperLink::StartMain, this, threads);
}

void HelperLink::Stop()
{
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		if (m_status.state == kReady || m_status.state == kStarting)
		{
			m_status.state = kOff;
			m_status.reason = "stopped";
		}
	}
	Kill();
}

void HelperLink::Reload(int threads)
{
	Stop();
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		m_status.failures = 0;
		m_status.givenUp = false;
		m_retryAt = GetTickCount();
		if (m_status.state == kBroken)
			m_status.state = kOff;
	}
	Ensure(threads);
}

// Ends the helper's process; its handles are closed by whoever starts the next one, never while another thread may be reading the pipe.
void HelperLink::Kill()
{
	HANDLE proc = (HANDLE)m_proc;
	if (proc)
		TerminateProcess(proc, 1);
}

void HelperLink::Fail(const std::string& why)
{
	Kill();
	std::lock_guard<std::mutex> lock(m_mtx);
	if (m_status.state == kOff || m_status.state == kBroken)
		return; // stopped on purpose, or already reported
	m_status.state = kBroken;
	m_status.reason = why;
	m_status.failures++;
	if (m_status.failures >= kMaxFailures)
	{
		m_status.givenUp = true;
		m_status.reason += " (given up after " + std::to_string(kMaxFailures) + " failures: cl_h9_tts_reload tries again)";
	}
	unsigned back = kRetryBaseMs << (m_status.failures > 5 ? 5 : m_status.failures - 1);
	m_retryAt = GetTickCount() + (back > kRetryMaxMs ? kRetryMaxMs : back);
}

bool HelperLink::VerifyFiles(std::string* why)
{
	static const char* files[] = { "bin/h9kokoro64.exe", "bin/onnxruntime.dll", "bin/onnxruntime_providers_shared.dll" };
	for (size_t i = 0; i < sizeof(files) / sizeof(files[0]); i++)
	{
		std::string want;
		const bool required = i < 2;
		if (!ManifestHash(m_dir, files[i], want))
		{
			if (required)
			{
				*why = std::string("h9tts\\manifest.txt does not list ") + files[i];
				return false;
			}
			continue;
		}
		std::wstring path = m_dir + L"\\" + Widen(files[i]);
		for (size_t k = 0; k < path.size(); k++)
		{
			if (path[k] == L'/')
				path[k] = L'\\';
		}
		FILE* f = _wfopen(path.c_str(), L"rb");
		if (!f)
		{
			if (required)
			{
				*why = std::string(files[i]) + " is missing";
				return false;
			}
			continue;
		}
		const std::string got = Sha256::OfFile(f);
		fclose(f);
		if (got != want)
		{
			*why = std::string(files[i]) + " does not match h9tts\\manifest.txt";
			return false;
		}
	}
	return true;
}

// ---- the pipe ---------------------------------------------------------------------------------------------------------------

bool HelperLink::ReadExact(void* buf, uint32_t n, uint32_t timeoutMs, int* what)
{
	uint8_t* p = (uint8_t*)buf;
	const DWORD t0 = GetTickCount();
	while (n > 0)
	{
		OVERLAPPED ov;
		memset(&ov, 0, sizeof(ov));
		ov.hEvent = (HANDLE)m_readEvent;
		ResetEvent(ov.hEvent);
		DWORD got = 0;
		if (!ReadFile((HANDLE)m_pipe, p, n > 65536 ? 65536 : n, &got, &ov))
		{
			if (GetLastError() != ERROR_IO_PENDING)
			{
				*what = kReadError;
				return false;
			}
			const DWORD spent = GetTickCount() - t0;
			const DWORD left = spent >= timeoutMs ? 0 : timeoutMs - spent;
			HANDLE waits[2] = { ov.hEvent, (HANDLE)m_proc };
			const DWORD w = WaitForMultipleObjects(2, waits, FALSE, left);
			if (w != WAIT_OBJECT_0)
			{
				CancelIoEx((HANDLE)m_pipe, &ov);
				GetOverlappedResult((HANDLE)m_pipe, &ov, &got, TRUE);
				*what = (w == WAIT_TIMEOUT) ? kReadTimeout : kReadError;
				return false;
			}
			if (!GetOverlappedResult((HANDLE)m_pipe, &ov, &got, FALSE))
			{
				*what = kReadError;
				return false;
			}
		}
		if (got == 0)
		{
			*what = kReadError;
			return false;
		}
		p += got;
		n -= got;
	}
	return true;
}

bool HelperLink::WriteAll(const void* buf, uint32_t n)
{
	const uint8_t* p = (const uint8_t*)buf;
	while (n > 0)
	{
		OVERLAPPED ov;
		memset(&ov, 0, sizeof(ov));
		ov.hEvent = (HANDLE)m_writeEvent;
		ResetEvent(ov.hEvent);
		DWORD wrote = 0;
		if (!WriteFile((HANDLE)m_pipe, p, n, &wrote, &ov))
		{
			if (GetLastError() != ERROR_IO_PENDING)
				return false;
			HANDLE waits[2] = { ov.hEvent, (HANDLE)m_proc };
			const DWORD w = WaitForMultipleObjects(2, waits, FALSE, kWriteMs);
			if (w != WAIT_OBJECT_0)
			{
				CancelIoEx((HANDLE)m_pipe, &ov);
				GetOverlappedResult((HANDLE)m_pipe, &ov, &wrote, TRUE);
				return false;
			}
			if (!GetOverlappedResult((HANDLE)m_pipe, &ov, &wrote, FALSE))
				return false;
		}
		if (wrote == 0)
			return false;
		p += wrote;
		n -= wrote;
	}
	return true;
}

bool HelperLink::SendFrame(uint32_t type, const uint8_t* payload, uint32_t length)
{
	std::vector<uint8_t> frame(proto::kHeadSize + length);
	proto::MakeHead(frame.data(), type, length);
	if (length)
		memcpy(&frame[proto::kHeadSize], payload, length);
	return WriteAll(frame.data(), (uint32_t)frame.size());
}

// One frame, checked: the head must be ours, the type known and the size right for it.
bool HelperLink::ReadFrame(uint32_t* type, std::vector<uint8_t>& payload, uint32_t timeoutMs, int* what)
{
	uint8_t head[proto::kHeadSize];
	if (!ReadExact(head, sizeof(head), timeoutMs, what))
		return false;
	uint32_t length = 0;
	if (!proto::CheckHead(head, type, &length) || *type < proto::kReady || !proto::PayloadOk(*type, length))
	{
		*what = kReadError;
		return false;
	}
	payload.resize(length);
	if (length && !ReadExact(payload.data(), length, 10000, what))
		return false;
	return true;
}

// ---- starting ---------------------------------------------------------------------------------------------------------------

void HelperLink::StartMain(int threads)
{
	std::string why;
	std::wstring dir;
	uint32_t crc = 0;
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		dir = m_dir;
		crc = m_catalogueCrc;
	}
	if (threads <= 0)
		threads = AutoThreads();
	if (threads <= 0)
	{
		Fail("this machine has fewer than 4 logical processors: too small for the Kokoro voices");
		return;
	}
	if (!VerifyFiles(&why))
	{
		Fail(why);
		return;
	}

	// the old process and pipe of an earlier start, now that nobody reads them
	m_drainId = 0;
	{
		std::lock_guard<std::mutex> io(m_ioMtx);
		if (m_proc)
		{
			TerminateProcess((HANDLE)m_proc, 1);
			CloseHandle((HANDLE)m_proc);
		}
		if (m_pipe)
			CloseHandle((HANDLE)m_pipe);
		if (m_job)
			CloseHandle((HANDLE)m_job);
		m_proc = m_pipe = m_job = nullptr;
	}

	// the pipe: a name made for this run, made by the client, for this user, no remote client
	wchar_t name[96];
	LARGE_INTEGER qpc;
	QueryPerformanceCounter(&qpc);
	_snwprintf(name, 96, L"\\\\.\\pipe\\h9kokoro-%lu-%lu-%08lx%08lx", GetCurrentProcessId(), GetTickCount(), (unsigned long)qpc.HighPart, (unsigned long)qpc.LowPart);
	name[95] = 0;
	SECURITY_ATTRIBUTES sa;
	memset(&sa, 0, sizeof(sa));
	sa.nLength = sizeof(sa);
	PSECURITY_DESCRIPTOR sd = nullptr;
	if (ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)(A;;GA;;;SY)", SDDL_REVISION_1, &sd, nullptr))
		sa.lpSecurityDescriptor = sd;
	HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
		1, 1u << 20, 1u << 20, 0, sd ? &sa : nullptr);
	if (sd)
		LocalFree(sd);
	if (pipe == INVALID_HANDLE_VALUE)
	{
		Fail("cannot make the pipe");
		return;
	}

	// the process: hidden, below normal priority, suspended until it is in its job
	const std::wstring exe = dir + L"\\bin\\h9kokoro64.exe";
	wchar_t cmd[1400];
	_snwprintf(cmd, 1400, L"\"%ls\" --serve --pipe %ls --parent %lu --threads %d", exe.c_str(), name, GetCurrentProcessId(), threads);
	cmd[1399] = 0;
	STARTUPINFOW si;
	memset(&si, 0, sizeof(si));
	si.cb = sizeof(si);
	si.dwFlags = STARTF_USESHOWWINDOW;
	si.wShowWindow = SW_HIDE;
	PROCESS_INFORMATION pi;
	memset(&pi, 0, sizeof(pi));
	if (!CreateProcessW(exe.c_str(), cmd, nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS, nullptr, (dir + L"\\bin").c_str(), &si, &pi))
	{
		CloseHandle(pipe);
		char buf[80];
		snprintf(buf, sizeof(buf), "cannot start the helper (Windows error %lu)", GetLastError());
		Fail(buf);
		return;
	}
	HANDLE job = CreateJobObjectW(nullptr, nullptr);
	if (job)
	{
		JOBOBJECT_EXTENDED_LIMIT_INFORMATION info;
		memset(&info, 0, sizeof(info));
		info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
		info.ProcessMemoryLimit = kMemoryLimit;
		SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info));
		AssignProcessToJobObject(job, pi.hProcess); // refused where the game already lives in a job that does not allow it: the helper then ends with its pipe
	}
	ResumeThread(pi.hThread);
	CloseHandle(pi.hThread);
	{
		std::lock_guard<std::mutex> io(m_ioMtx);
		m_proc = pi.hProcess;
		m_pipe = pipe;
		m_job = job;
	}
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		m_status.starts++;
		m_status.reason = "loading the model";
	}

	// the helper connects to the pipe
	OVERLAPPED ov;
	memset(&ov, 0, sizeof(ov));
	ov.hEvent = (HANDLE)m_readEvent;
	ResetEvent(ov.hEvent);
	bool connected = false;
	if (ConnectNamedPipe(pipe, &ov))
		connected = true;
	else if (GetLastError() == ERROR_PIPE_CONNECTED)
		connected = true;
	else if (GetLastError() == ERROR_IO_PENDING)
	{
		HANDLE waits[2] = { ov.hEvent, pi.hProcess };
		const DWORD w = WaitForMultipleObjects(2, waits, FALSE, kConnectMs);
		if (w == WAIT_OBJECT_0)
		{
			DWORD got = 0;
			connected = GetOverlappedResult(pipe, &ov, &got, FALSE) != FALSE;
		}
		else
		{
			CancelIoEx(pipe, &ov);
			DWORD got = 0;
			GetOverlappedResult(pipe, &ov, &got, TRUE);
		}
	}
	if (!connected)
	{
		DWORD code = STILL_ACTIVE;
		GetExitCodeProcess(pi.hProcess, &code);
		char buf[200];
		if (code != STILL_ACTIVE)
			snprintf(buf, sizeof(buf), "the helper ended before it connected to the pipe (exit code %lu: 3 its data or ONNX Runtime would not load, 4 the pipe, else a crash or a library it needs)", (unsigned long)code);
		else
			snprintf(buf, sizeof(buf), "the helper did not connect to the pipe in %u s (it loads its model before it connects: a slow disk or a busy machine)", kConnectMs / 1000);
		Fail(buf);
		return;
	}

	// HELLO, then READY once the model is loaded
	uint8_t hello[20];
	proto::Put32(hello, proto::kVersion);
	proto::Put32(hello + 4, GetCurrentProcessId());
	proto::Put32(hello + 8, (uint32_t)threads);
	proto::Put32(hello + 12, 0);
	proto::Put32(hello + 16, crc);
	{
		std::lock_guard<std::mutex> io(m_ioMtx);
		if (!SendFrame(proto::kHello, hello, sizeof(hello)))
		{
			Fail("cannot talk to the helper");
			return;
		}
		uint32_t type = 0;
		std::vector<uint8_t> payload;
		int what = 0;
		for (;;)
		{
			if (!ReadFrame(&type, payload, kReadyMs, &what))
			{
				if (what == kReadTimeout)
					Fail("the helper did not become ready in time");
				else
				{
					DWORD code = 0;
					GetExitCodeProcess(pi.hProcess, &code);
					char buf[160];
					snprintf(buf, sizeof(buf), "the helper ended before it was ready (exit code %lu: 3 its data or ONNX Runtime would not load, 4 the pipe, else a crash or a library it needs)", (unsigned long)code);
					Fail(buf);
				}
				return;
			}
			if (type == proto::kError)
			{
				Fail("the helper reported: " + std::string((const char*)payload.data() + 8, payload.size() - 8));
				return;
			}
			if (type == proto::kReady)
				break;
		}
		if (proto::Get32(&payload[0]) != proto::kVersion)
		{
			Fail("the helper speaks another protocol version");
			return;
		}
		if (proto::Get32(&payload[16]) != crc)
		{
			Fail("the helper loaded another voice catalogue than the game (voices.txt differs)");
			return;
		}
		std::lock_guard<std::mutex> lock(m_mtx);
		if (m_status.state != kStarting)
			return; // stopped while it was starting
		m_status.state = kReady;
		m_status.reason = "ready";
		m_status.threads = (int)proto::Get32(&payload[8]);
		m_status.loadMs = (int)proto::Get32(&payload[12]);
		m_status.ortMajorMinor = (int)proto::Get32(&payload[20]);
		m_status.failures = 0;
	}
}

// ---- a line -----------------------------------------------------------------------------------------------------------------

// The line cancelled for being late may have frames still to come (a piece it was making, its DONE). They are read and dropped, so that the next line's
// frames are the next in the pipe. False when its DONE has not come within maxWaitMs (the helper is still finishing it), or the helper is gone.
bool HelperLink::DrainCancelled(unsigned maxWaitMs)
{
	const DWORD t0 = GetTickCount();
	while (m_drainId)
	{
		if (GetTickCount() - t0 >= maxWaitMs)
			return false;
		DWORD avail = 0;
		if (!PeekNamedPipe((HANDLE)m_pipe, nullptr, 0, nullptr, &avail, nullptr))
		{
			m_drainId = 0;
			Fail("the helper's pipe broke");
			return false;
		}
		if (avail < proto::kHeadSize)
		{
			if (WaitForSingleObject((HANDLE)m_proc, 10) == WAIT_OBJECT_0)
			{
				avail = 0;
				if (PeekNamedPipe((HANDLE)m_pipe, nullptr, 0, nullptr, &avail, nullptr) && avail >= proto::kHeadSize)
					continue;
				m_drainId = 0;
				Fail("the helper ended while a cancelled line was still going");
				return false;
			}
			continue;
		}
		uint32_t type = 0;
		std::vector<uint8_t> p;
		int what = 0;
		if (!ReadFrame(&type, p, 10000, &what))
		{
			m_drainId = 0;
			Fail("the helper's pipe broke or sent what it should not");
			return false;
		}
		if (type == proto::kDone && proto::Get32(&p[0]) == m_drainId)
			m_drainId = 0;
	}
	return true;
}

// A helper that was asked to cancel a late line and has said nothing for kCancelDrainMs is not slow, it is stuck.
void HelperLink::Watch()
{
	if (m_drainId && (unsigned)(GetTickCount() - m_drainSince) > kCancelDrainMs)
	{
		m_drainId = 0;
		Fail("the helper did not answer a cancelled line");
	}
}

HelperLink::Result HelperLink::Synthesize(int kind, int index, bool stream, const char* text, unsigned firstMs, const PieceFn& onPiece, const CancelFn& cancelled)
{
	{
		std::lock_guard<std::mutex> lock(m_mtx);
		if (m_status.state != kReady)
			return kNotReady;
	}
	const size_t textLen = strlen(text);
	if (textLen == 0 || textLen > proto::kMaxText || kind < 0 || kind > 4 || index < 1 || index > 99)
		return kFailed;
	std::lock_guard<std::mutex> io(m_ioMtx);
	if (!m_pipe || !m_proc)
		return kNotReady;
	if (m_drainId && !DrainCancelled(kDrainWaitMs))
		return kBusy;
	const unsigned firstLimit = firstMs ? firstMs : kFirstPieceMs;
	uint32_t id = m_nextId++;
	if (id == 0)
		id = m_nextId++;
	std::vector<uint8_t> req(12 + textLen);
	proto::Put32(&req[0], id);
	req[4] = (uint8_t)kind;
	req[5] = (uint8_t)index;
	req[6] = stream ? 1 : 0;
	req[7] = 0;
	proto::Put32(&req[8], (uint32_t)textLen);
	memcpy(&req[12], text, textLen);
	const DWORD t0 = GetTickCount();
	if (!SendFrame(proto::kSynth, req.data(), (uint32_t)req.size()))
	{
		Fail("cannot send a line to the helper");
		return kFailed;
	}
	bool sentCancel = false;
	uint32_t expectSeq = 0;
	int lastFirstMs = 0;
	for (;;)
	{
		uint32_t type = 0;
		std::vector<uint8_t> p;
		int what = 0;
		const unsigned timeout = sentCancel ? kCancelDrainMs : (expectSeq == 0 ? firstLimit : kNextPieceMs);
		// wait for the next frame to begin, looking every 10 ms whether the line is wanted still
		const DWORD tw = GetTickCount();
		for (;;)
		{
			DWORD avail = 0;
			if (!PeekNamedPipe((HANDLE)m_pipe, nullptr, 0, nullptr, &avail, nullptr))
			{
				Fail("the helper's pipe broke");
				return kFailed;
			}
			if (avail >= proto::kHeadSize)
				break;
			if (!sentCancel && cancelled && cancelled())
			{
				uint8_t c[4];
				proto::Put32(c, id);
				SendFrame(proto::kCancel, c, 4);
				sentCancel = true;
			}
			if (GetTickCount() - tw > timeout)
			{
				if (expectSeq == 0 && !sentCancel)
				{
					// slow, not dead: the line is cancelled and the caller speaks it another way; what the helper still sends for it is dropped later
					uint8_t c[4];
					proto::Put32(c, id);
					SendFrame(proto::kCancel, c, 4);
					m_drainSince = GetTickCount();
					m_drainId = id;
					std::lock_guard<std::mutex> lock(m_mtx);
					m_status.lateLines++;
					m_status.lastFirstMs = (int)(GetTickCount() - t0);
					m_status.lastTotalMs = m_status.lastFirstMs;
					return kLate;
				}
				Fail("the helper was late with a line and was stopped");
				return kFailed;
			}
			if (WaitForSingleObject((HANDLE)m_proc, 10) == WAIT_OBJECT_0)
			{
				// it ended: what it wrote before it did is still in the pipe and is read first
				avail = 0;
				if (PeekNamedPipe((HANDLE)m_pipe, nullptr, 0, nullptr, &avail, nullptr) && avail >= proto::kHeadSize)
					break;
				Fail("the helper ended while it was making a line");
				return kFailed;
			}
		}
		if (!ReadFrame(&type, p, 10000, &what))
		{
			Fail("the helper's pipe broke or sent what it should not");
			return kFailed;
		}
		if (type == proto::kChunk)
		{
			const uint32_t cid = proto::Get32(&p[0]), seq = proto::Get16(&p[4]), flags = proto::Get16(&p[6]), rate = proto::Get32(&p[8]), samples = proto::Get32(&p[12]);
			if (cid != id || seq != expectSeq || rate != proto::kSampleRate || samples < 2 || samples > 24000u * 30u || (size_t)samples * 2 + 20 != p.size()
				|| ((flags & proto::kChunkFirst) != 0) != (expectSeq == 0))
			{
				Fail("the helper sent a piece that does not belong to the line");
				return kFailed;
			}
			if (expectSeq == 0)
				lastFirstMs = (int)(GetTickCount() - t0);
			expectSeq++;
			if (!sentCancel)
			{
				std::vector<int16_t> pcm(samples);
				for (uint32_t i = 0; i < samples; i++)
					pcm[i] = (int16_t)proto::Get16(&p[20 + 2 * i]);
				Piece piece = { pcm.data(), (int)samples, (flags & proto::kChunkFirst) != 0, (flags & proto::kChunkLast) != 0, (flags & proto::kChunkCached) != 0 };
				onPiece(piece);
			}
		}
		else if (type == proto::kDone)
		{
			if (proto::Get32(&p[0]) != id)
			{
				Fail("the helper ended a line that is not the one asked for");
				return kFailed;
			}
			const uint32_t status = proto::Get32(&p[4]);
			std::lock_guard<std::mutex> lock(m_mtx);
			if (status == proto::kDoneBusy)
			{
				m_status.busyLines++;
				return kBusy;
			}
			m_status.lines++;
			if (proto::Get32(&p[20]) & 1)
				m_status.cacheHits++;
			m_status.lastFirstMs = lastFirstMs;
			m_status.lastTotalMs = (int)(GetTickCount() - t0);
			if (status == proto::kDoneOk)
				return sentCancel ? kCancelled : kOk;
			return (status == proto::kDoneCancelled) ? kCancelled : kFailed;
		}
		else if (type == proto::kError)
		{
			std::lock_guard<std::mutex> lock(m_mtx);
			m_status.reason = std::string("helper: ") + std::string((const char*)p.data() + 8, p.size() - 8);
		}
		// PONG, LOG and a repeated READY are not for this line
		if (!sentCancel && cancelled && cancelled())
		{
			uint8_t c[4];
			proto::Put32(c, id);
			SendFrame(proto::kCancel, c, 4);
			sentCancel = true;
		}
	}
}
} // namespace kokoro
} // namespace h9tts

#endif // H9TTS_HAVE_KOKORO
