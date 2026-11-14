// ---- h9kokoro64: the conversation with the client -------------------------------------------------------------------------
// The client created a named pipe and started this process with its name; the helper opens the pipe and speaks the protocol of
// reTS\cl_dll\h9_tts_proto.h over it. Two threads: the reader (this thread) takes frames, a worker makes the lines. One line at a time; a short
// queue (kMaxQueued), where a new line that finds it full pushes out the oldest, which nobody will hear any more.
//
// A line is made phrase by phrase and every phrase is sent as soon as it is made. A line made before is kept (the whole line, by voice and text) and
// is sent again without the model. The helper starts no new line while it has worked in the model more than kDutyPercent of the last kDutyWindowMs
// (a rolling duty cycle): that line is answered at once with DONE busy and the client speaks it another way, so a flood of lines is not run flat out
// and nobody waits for a line that is not coming. A line that has been started is made to its end without pauses between its phrases.
//
// The helper ends when the pipe breaks, on SHUTDOWN, on a bad frame, or when the client's process is gone.
#pragma once

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <list>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "h9_tts_proto.h"
#include "synth.h"

namespace h9k
{
// A trace of the conversation for finding faults: when the environment variable H9K_LOG names a file, every frame sent and received is noted there.
inline void Trace(const char* fmt, ...)
{
	static const char* path = getenv("H9K_LOG");
	if (!path || !path[0])
		return;
	static std::mutex mtx;
	std::lock_guard<std::mutex> lock(mtx);
	FILE* f = fopen(path, "ab");
	if (!f)
		return;
	fprintf(f, "%lu ", GetTickCount());
	va_list ap;
	va_start(ap, fmt);
	vfprintf(f, fmt, ap);
	va_end(ap);
	fputs("\n", f);
	fclose(f);
}

// ---- the cache of lines made ------------------------------------------------------------------------------------------------

struct CachedLine
{
	std::vector<std::vector<int16_t> > chunks;
	size_t Bytes() const
	{
		size_t n = 0;
		for (size_t i = 0; i < chunks.size(); i++)
			n += chunks[i].size() * 2;
		return n;
	}
};

// Least recently used lines, kept up to a number of bytes. One thread uses it (the worker).
class LineCache
{
public:
	explicit LineCache(size_t maxBytes) : m_max(maxBytes), m_bytes(0) {}

	bool Get(uint64_t key, CachedLine& out)
	{
		std::map<uint64_t, std::list<Item>::iterator>::iterator it = m_map.find(key);
		if (it == m_map.end())
			return false;
		m_lru.splice(m_lru.begin(), m_lru, it->second);
		out = it->second->line;
		return true;
	}

	void Put(uint64_t key, const CachedLine& line)
	{
		const size_t bytes = line.Bytes();
		if (bytes == 0 || bytes > m_max / 2)
			return;
		std::map<uint64_t, std::list<Item>::iterator>::iterator it = m_map.find(key);
		if (it != m_map.end())
		{
			m_bytes -= it->second->line.Bytes();
			m_lru.erase(it->second);
			m_map.erase(it);
		}
		Item item = { key, line };
		m_lru.push_front(item);
		m_map[key] = m_lru.begin();
		m_bytes += bytes;
		while (m_bytes > m_max && !m_lru.empty())
		{
			m_bytes -= m_lru.back().line.Bytes();
			m_map.erase(m_lru.back().key);
			m_lru.pop_back();
		}
	}

	size_t Entries() const { return m_lru.size(); }
	size_t Bytes() const { return m_bytes; }

private:
	struct Item
	{
		uint64_t key;
		CachedLine line;
	};
	size_t m_max, m_bytes;
	std::list<Item> m_lru;
	std::map<uint64_t, std::list<Item>::iterator> m_map;
};

// ---- the server ---------------------------------------------------------------------------------------------------------------

class Server
{
public:
	static const int kMaxThreads = 16;         // the most threads the model is given, whatever the client asks
	static const int kMaxQueued = 3;           // lines waiting for the worker
	static const int kMaxQueueAgeMs = 8000;    // a line that waited this long is stale
	static const int kDutyWindowMs = 10000;
	static const int kDutyPercent = 50;
	static const uint32_t kBuild = 2;

	Server(Engine& eng, const PhrasePolicy& pol) : m_eng(eng), m_pol(pol), m_pipe(INVALID_HANDLE_VALUE), m_cache(24u << 20), m_quit(false), m_runningId(0),
		m_cancelRunning(false), m_pendingThreads(0), m_served(0) {}

	// Opens the client's pipe (retrying for a few seconds) and runs the conversation. Returns the process's exit code.
	int Run(const std::wstring& pipeName, uint32_t parentPid)
	{
		if (parentPid)
			StartParentWatch(parentPid);
		for (int tries = 0; tries < 100 && m_pipe == INVALID_HANDLE_VALUE; tries++)
		{
			m_pipe = CreateFileW(pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, nullptr);
			if (m_pipe == INVALID_HANDLE_VALUE)
				Sleep(50);
		}
		if (m_pipe == INVALID_HANDLE_VALUE)
			return 4;
		m_readEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
		m_writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
		m_worker = std::thread(&Server::WorkerMain, this);
		const int rc = ReadLoop();
		m_quit = true;
		m_eng.Cancel();
		m_qCv.notify_all();
		// the process ends here, with the worker perhaps in the middle of a line: ExitProcess does not wait for a thread or run a destructor
		ExitProcess((UINT)rc);
		return rc;
	}

	bool Quitting() const { return m_quit; }

private:
	struct Req
	{
		uint32_t id;
		int kind, index;
		bool stream;
		std::string text;
		DWORD arrived;
	};

	// One read or write on the pipe, waited for. The handle is overlapped and each direction has its own event, so a read that is waiting for the
	// client's next frame does not hold up the worker's writes (a synchronous handle would serialise the two).
	bool Overlapped(bool read, void* buf, DWORD n, DWORD* done)
	{
		OVERLAPPED ov;
		memset(&ov, 0, sizeof(ov));
		ov.hEvent = read ? m_readEvent : m_writeEvent;
		ResetEvent(ov.hEvent);
		*done = 0;
		const BOOL ok = read ? ReadFile(m_pipe, buf, n, nullptr, &ov) : WriteFile(m_pipe, buf, n, nullptr, &ov);
		if (!ok && GetLastError() != ERROR_IO_PENDING)
			return false;
		return GetOverlappedResult(m_pipe, &ov, done, TRUE) != FALSE;
	}

	// ---- the reader

	bool ReadFull(void* buf, size_t n)
	{
		uint8_t* p = (uint8_t*)buf;
		while (n > 0)
		{
			DWORD got = 0;
			if (!Overlapped(true, p, (DWORD)(n > 65536 ? 65536 : n), &got) || got == 0)
				return false;
			p += got;
			n -= got;
		}
		return true;
	}

	int ReadLoop()
	{
		uint8_t head[h9tts::proto::kHeadSize];
		std::vector<uint8_t> payload;
		while (!m_quit)
		{
			if (!ReadFull(head, sizeof(head)))
				return 0; // the pipe is gone: the client is
			uint32_t type = 0, length = 0;
			if (!h9tts::proto::CheckHead(head, &type, &length) || !h9tts::proto::PayloadOk(type, length))
			{
				SendError(0, 1, "bad frame");
				return 5;
			}
			payload.resize(length);
			if (length && !ReadFull(payload.data(), length))
				return 0;
			Trace("recv type %u length %u", type, length);
			if (!Dispatch(type, payload))
				return 0;
		}
		return 0;
	}

	// A thread count the client asks for: 0 leaves it as it is, anything above kMaxThreads is kMaxThreads.
	static uint32_t ClampThreads(uint32_t n) { return n > (uint32_t)kMaxThreads ? (uint32_t)kMaxThreads : n; }

	bool Dispatch(uint32_t type, const std::vector<uint8_t>& p)
	{
		using namespace h9tts::proto;
		switch (type)
		{
		case kHello:
		{
			if (Get32(&p[0]) != kVersion)
			{
				SendError(0, 2, "protocol version not supported");
				return false;
			}
			const uint32_t threads = ClampThreads(Get32(&p[8]));
			if (threads > 0 && (int)threads != m_eng.Threads())
				m_pendingThreads = threads;
			m_clientCrc = Get32(&p[16]);
			m_qCv.notify_all();
			if (!m_pendingThreads)
				SendReady();
			return true;
		}
		case kSynth:
		{
			const uint32_t textLen = Get32(&p[8]);
			if (textLen != p.size() - 12 || textLen == 0 || textLen > kMaxText)
			{
				SendError(Get32(&p[0]), 3, "bad text length");
				return true;
			}
			Req r;
			r.id = Get32(&p[0]);
			r.kind = p[4];
			r.index = p[5];
			r.stream = (p[6] & 1) != 0;
			r.text.assign((const char*)&p[12], textLen);
			r.arrived = GetTickCount();
			Enqueue(r);
			return true;
		}
		case kCancel:
			Cancel(Get32(&p[0]));
			return true;
		case kSetThreads:
		{
			const uint32_t threads = ClampThreads(Get32(&p[0]));
			if (threads > 0 && (int)threads != m_eng.Threads())
			{
				m_pendingThreads = threads;
				m_eng.Cancel();
				m_qCv.notify_all();
			}
			return true;
		}
		case kPing:
		{
			uint8_t b[20];
			Put32(b, Get32(&p[0]));
			Put32(b + 4, (uint32_t)QueuedCount());
			Put32(b + 8, (uint32_t)m_eng.Threads());
			Put32(b + 12, (uint32_t)m_cache.Entries());
			Put32(b + 16, m_served);
			Send(kPong, b, sizeof(b));
			return true;
		}
		case kShutdown:
			return false;
		default:
			return true;
		}
	}

	void Enqueue(const Req& r)
	{
		std::vector<uint32_t> stale;
		{
			std::lock_guard<std::mutex> lock(m_qMtx);
			while ((int)m_queue.size() >= kMaxQueued)
			{
				stale.push_back(m_queue.front().id);
				m_queue.pop_front();
			}
			m_queue.push_back(r);
		}
		for (size_t i = 0; i < stale.size(); i++)
			SendDone(stale[i], h9tts::proto::kDoneStale, 0, 0, 0, 0);
		m_qCv.notify_one();
	}

	void Cancel(uint32_t id)
	{
		bool pending = false;
		{
			// the worker takes a line from the queue and marks it running under this same lock, so a line is always one or the other
			std::lock_guard<std::mutex> lock(m_qMtx);
			for (std::deque<Req>::iterator it = m_queue.begin(); it != m_queue.end(); ++it)
			{
				if (it->id == id)
				{
					m_queue.erase(it);
					pending = true;
					break;
				}
			}
			if (!pending && m_runningId == id)
			{
				m_cancelRunning = true;
				m_eng.Cancel();
			}
		}
		if (pending)
			SendDone(id, h9tts::proto::kDoneCancelled, 0, 0, 0, 0);
	}

	size_t QueuedCount()
	{
		std::lock_guard<std::mutex> lock(m_qMtx);
		return m_queue.size();
	}

	// ---- sending

	bool Send(uint32_t type, const uint8_t* payload, size_t length)
	{
		std::vector<uint8_t> frame(h9tts::proto::kHeadSize + length);
		h9tts::proto::MakeHead(frame.data(), type, (uint32_t)length);
		if (length)
			memcpy(&frame[h9tts::proto::kHeadSize], payload, length);
		Trace("send type %u length %u", type, (unsigned)length);
		std::lock_guard<std::mutex> lock(m_writeMtx);
		size_t off = 0;
		while (off < frame.size())
		{
			DWORD wrote = 0;
			const bool ok = Overlapped(false, &frame[off], (DWORD)std::min<size_t>(frame.size() - off, 65536), &wrote);
			if (!ok || wrote == 0)
			{
				m_quit = true;
				return false;
			}
			off += wrote;
		}
		return true;
	}

	void SendReady()
	{
		using namespace h9tts::proto;
		uint8_t b[28];
		Put32(b, kVersion);
		Put32(b + 4, kBuild);
		Put32(b + 8, (uint32_t)m_eng.Threads());
		Put32(b + 12, (uint32_t)m_eng.LoadMs());
		Put32(b + 16, m_eng.CatalogueCrc());
		unsigned major = 0, minor = 0;
		sscanf(m_eng.OrtVersion().c_str(), "%u.%u", &major, &minor);
		Put32(b + 20, (major << 8) | minor);
		Put32(b + 24, 0);
		Send(kReady, b, sizeof(b));
	}

	void SendError(uint32_t id, uint32_t code, const char* text)
	{
		uint8_t b[8 + 128];
		const size_t n = std::min<size_t>(strlen(text), 128);
		h9tts::proto::Put32(b, id);
		h9tts::proto::Put32(b + 4, code);
		memcpy(b + 8, text, n);
		Send(h9tts::proto::kError, b, 8 + n);
	}

	void SendDone(uint32_t id, uint32_t status, uint32_t chunks, uint32_t totalMs, uint32_t g2pUs, uint32_t flags)
	{
		uint8_t b[24];
		h9tts::proto::Put32(b, id);
		h9tts::proto::Put32(b + 4, status);
		h9tts::proto::Put32(b + 8, chunks);
		h9tts::proto::Put32(b + 12, totalMs);
		h9tts::proto::Put32(b + 16, g2pUs);
		h9tts::proto::Put32(b + 20, flags);
		Send(h9tts::proto::kDone, b, sizeof(b));
	}

	bool SendChunk(uint32_t id, uint32_t seq, uint32_t flags, const std::vector<int16_t>& pcm, uint32_t synthMs)
	{
		using namespace h9tts::proto;
		if (pcm.size() * 2 + 20 > kMaxPayload)
			return false;
		std::vector<uint8_t> b(20 + pcm.size() * 2);
		Put32(&b[0], id);
		Put16(&b[4], seq);
		Put16(&b[6], flags);
		Put32(&b[8], kSampleRate);
		Put32(&b[12], (uint32_t)pcm.size());
		Put32(&b[16], synthMs);
		for (size_t i = 0; i < pcm.size(); i++)
			Put16(&b[20 + i * 2], (uint32_t)(uint16_t)pcm[i]);
		return Send(kChunk, b.data(), b.size());
	}

	// ---- the worker

	void StartParentWatch(uint32_t pid)
	{
		HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, pid);
		if (!parent)
			return; // the client's process is gone already, or not ours to watch: the pipe ending is the other way out
		m_watch = std::thread([parent]() {
			WaitForSingleObject(parent, INFINITE);
			ExitProcess(3);
		});
		m_watch.detach();
	}

	// The model's busy time over the last window.
	int BusyMs(DWORD now)
	{
		int total = 0;
		while (!m_busy.empty() && (int)(now - m_busy.front().first) > kDutyWindowMs)
			m_busy.pop_front();
		for (size_t i = 0; i < m_busy.size(); i++)
			total += m_busy[i].second;
		return total;
	}

	// Whether the helper has worked more than its share of the last window, so that a new line is not started.
	bool OverDuty() { return BusyMs(GetTickCount()) > kDutyWindowMs * kDutyPercent / 100; }

	void WorkerMain()
	{
		for (;;)
		{
			Req r;
			{
				std::unique_lock<std::mutex> lock(m_qMtx);
				m_qCv.wait(lock, [this] { return m_quit || m_pendingThreads || !m_queue.empty(); });
				if (m_quit)
					return;
				if (m_pendingThreads)
				{
					lock.unlock();
					ChangeThreads();
					continue;
				}
				r = m_queue.front();
				m_queue.pop_front();
				m_runningId = r.id;
				m_cancelRunning = false;
			}
			if ((int)(GetTickCount() - r.arrived) > kMaxQueueAgeMs)
			{
				SendDone(r.id, h9tts::proto::kDoneStale, 0, 0, 0, 0);
				m_runningId = 0;
				continue;
			}
			Process(r);
		}
	}

	void ChangeThreads()
	{
		const uint32_t want = m_pendingThreads.exchange(0);
		m_eng.ClearCancel();
		std::string err;
		if (want > 0 && (int)want != m_eng.Threads() && !m_eng.SetThreads((int)want, &err))
		{
			SendError(0, 4, err.c_str());
			m_quit = true;
			return;
		}
		SendReady();
	}

	void Process(const Req& r)
	{
		using namespace h9tts::proto;
		Trace("process line %u kind %d index %d text '%s'", r.id, r.kind, r.index, r.text.c_str());
		const DWORD t0 = GetTickCount();
		m_eng.ClearCancel();
		const h9fx::Variant* v = m_eng.VariantOf(r.kind, r.index);
		if (!v)
		{
			SendError(r.id, 5, "no such voice");
			SendDone(r.id, kDoneFailed, 0, 0, 0, 0);
			m_runningId = 0;
			return;
		}
		const std::string voiceKey = h9fx::VoiceKey(*v);
		const uint64_t key = h9tts::Fnv1a64(r.text.data(), r.text.size(), h9tts::Fnv1a64(voiceKey.data(), voiceKey.size()) ^ (r.stream ? 0x9E3779B97F4A7C15ULL : 0));
		CachedLine hit;
		if (m_cache.Get(key, hit))
		{
			for (size_t i = 0; i < hit.chunks.size(); i++)
			{
				const uint32_t flags = (i == 0 ? kChunkFirst : 0) | (i + 1 == hit.chunks.size() ? kChunkLast : 0) | kChunkCached;
				if (!SendChunk(r.id, (uint32_t)i, flags, hit.chunks[i], 0))
					break;
			}
			SendDone(r.id, kDoneOk, (uint32_t)hit.chunks.size(), (uint32_t)(GetTickCount() - t0), 0, 1);
			m_served++;
			m_runningId = 0;
			return;
		}
		std::vector<Phrase> phrases;
		int g2pUs = 0;
		if (!m_eng.PlanLine(r.text, r.stream, m_pol, phrases, &g2pUs))
		{
			SendDone(r.id, kDoneFailed, 0, (uint32_t)(GetTickCount() - t0), (uint32_t)g2pUs, 0);
			m_runningId = 0;
			return;
		}
		if (m_cancelRunning)
		{
			SendDone(r.id, kDoneCancelled, 0, (uint32_t)(GetTickCount() - t0), (uint32_t)g2pUs, 0);
			m_runningId = 0;
			return;
		}
		if (OverDuty())
		{
			SendDone(r.id, kDoneBusy, 0, (uint32_t)(GetTickCount() - t0), (uint32_t)g2pUs, 0);
			m_runningId = 0;
			return;
		}
		CachedLine made;
		uint32_t status = kDoneOk;
		for (size_t i = 0; i < phrases.size(); i++)
		{
			if (m_cancelRunning || m_quit || m_pendingThreads)
			{
				status = kDoneCancelled;
				break;
			}
			std::vector<int16_t> pcm;
			int synthMs = 0;
			std::string err;
			const DWORD t1 = GetTickCount();
			const bool last = i + 1 == phrases.size();
			Phrase ph = phrases[i];
			if (last)
				ph.pauseMs = 0;
			if (!m_eng.SynthPhrase(*v, ph, pcm, &synthMs, &err))
			{
				status = (err == "cancelled" || m_cancelRunning) ? kDoneCancelled : kDoneFailed;
				if (status == kDoneFailed)
					SendError(r.id, 6, err.c_str());
				break;
			}
			m_busy.push_back(std::make_pair(t1, (int)(GetTickCount() - t1)));
			const uint32_t flags = (i == 0 ? kChunkFirst : 0) | (last ? kChunkLast : 0);
			if (!SendChunk(r.id, (uint32_t)i, flags, pcm, (uint32_t)synthMs))
			{
				status = kDoneFailed;
				break;
			}
			made.chunks.push_back(pcm);
		}
		if (status == kDoneOk)
			m_cache.Put(key, made);
		SendDone(r.id, status, (uint32_t)made.chunks.size(), (uint32_t)(GetTickCount() - t0), (uint32_t)g2pUs, 0);
		m_served++;
		m_runningId = 0;
	}

	Engine& m_eng;
	PhrasePolicy m_pol;
	HANDLE m_pipe;
	HANDLE m_readEvent = nullptr;
	HANDLE m_writeEvent = nullptr;
	std::mutex m_writeMtx;
	std::mutex m_qMtx;
	std::condition_variable m_qCv;
	std::deque<Req> m_queue;
	LineCache m_cache;
	std::deque<std::pair<DWORD, int> > m_busy;
	std::thread m_worker, m_watch;
	std::atomic<bool> m_quit;
	std::atomic<uint32_t> m_runningId;
	std::atomic<bool> m_cancelRunning;
	std::atomic<uint32_t> m_pendingThreads;
	uint32_t m_served;
	uint32_t m_clientCrc = 0;
};
} // namespace h9k
