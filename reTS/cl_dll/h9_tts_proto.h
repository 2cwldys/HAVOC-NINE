// ---- H9 text to speech: the wire protocol between the client and the Kokoro helper process -----------------------------------
// The client library (32-bit) starts h9kokoro64.exe and talks to it over a named pipe the client creates (h9_tts_kokoro_link.cpp); the helper
// (tools/h9kokoro64) speaks the same protocol from its side. This header is shared by both, so it includes nothing of either.
//
// Everything is little endian. A frame is a 12-byte head and a payload of head.length bytes:
//     u32 magic ("H9VK")   u8 type   u8 flags (0)   u16 reserved (0)   u32 length
// Neither side trusts the other: a bad magic, an unknown type, a length over kProtoMaxPayload or a payload that does not fit its type ends the
// conversation (the client kills and restarts the helper, the helper exits). The helper also exits when the pipe breaks or the client's process ends.
//
//  client to helper
//    HELLO        u32 version, u32 client process id, u32 threads (0: the helper chooses), u32 flags (bit 0: the model's threads may spin), u32 catalogue crc32
//    SYNTH        u32 id, u8 kind (0 man, 1 woman, 2 mech, 3 bot, 4 droid), u8 variant index (1 to the kind's count), u8 flags (bit 0: cut the line into
//                 phrases and send them as they are made), u8 0, u32 text length, the text (UTF-8, at most kProtoMaxText bytes)
//    CANCEL       u32 id
//    SET_THREADS  u32 threads (the helper makes a new session; READY comes again when it is done)
//    PING         u32 token
//    SHUTDOWN     (empty)
//  helper to client
//    READY        u32 version, u32 build, u32 threads, u32 load milliseconds, u32 catalogue crc32, u32 ONNX Runtime version (major << 8 | minor), u32 flags
//    CHUNK        u32 id, u16 sequence (from 0), u16 flags (1 first, 2 last, 4 from the cache), u32 sample rate, u32 samples, u32 synthesis milliseconds,
//                 then the samples: signed 16 bit, mono; the raw trimmed line of the voice, without depth, mask or machine sound
//    DONE         u32 id, u32 status (0 ok, 1 cancelled, 2 failed, 3 dropped as stale, 4 not started: the helper had worked more than its share of the
//                 last ten seconds), u32 chunks, u32 total milliseconds, u32 g2p microseconds,
//                 u32 flags (1 the whole line came from the cache)
//    ERROR        u32 id (0: not about a line), u32 code, text
//    PONG         u32 token, u32 queued lines, u32 threads, u32 cache entries, u32 lines served
//    LOG          text
#pragma once

#include <stdint.h>

namespace h9tts
{
namespace proto
{
static const uint32_t kMagic = 0x4B563948u; // "H9VK"
static const uint32_t kVersion = 1;
static const uint32_t kHeadSize = 12;
static const uint32_t kMaxPayload = 1u << 20;
static const uint32_t kMaxText = 192;
static const uint32_t kSampleRate = 24000;

enum Type
{
	kHello = 1,
	kSynth = 2,
	kCancel = 3,
	kSetThreads = 4,
	kPing = 5,
	kShutdown = 6,

	kReady = 16,
	kChunk = 17,
	kDone = 18,
	kError = 19,
	kPong = 20,
	kLog = 21
};

enum ChunkFlags
{
	kChunkFirst = 1,
	kChunkLast = 2,
	kChunkCached = 4
};

enum DoneStatus
{
	kDoneOk = 0,
	kDoneCancelled = 1,
	kDoneFailed = 2,
	kDoneStale = 3,
	kDoneBusy = 4
};

inline void Put16(uint8_t* p, uint32_t v)
{
	p[0] = (uint8_t)(v & 0xFF);
	p[1] = (uint8_t)((v >> 8) & 0xFF);
}

inline void Put32(uint8_t* p, uint32_t v)
{
	for (int i = 0; i < 4; i++)
		p[i] = (uint8_t)((v >> (8 * i)) & 0xFF);
}

inline uint32_t Get16(const uint8_t* p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8);
}

inline uint32_t Get32(const uint8_t* p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// The head of a frame in head[12].
inline void MakeHead(uint8_t* head, uint32_t type, uint32_t length)
{
	Put32(head, kMagic);
	head[4] = (uint8_t)type;
	head[5] = 0;
	Put16(head + 6, 0);
	Put32(head + 8, length);
}

// Whether a head is one this protocol accepts; type and length come back.
inline bool CheckHead(const uint8_t* head, uint32_t* type, uint32_t* length)
{
	if (Get32(head) != kMagic || head[5] != 0 || Get16(head + 6) != 0)
		return false;
	*type = head[4];
	*length = Get32(head + 8);
	return *length <= kMaxPayload;
}

// The smallest payload each message type may have, and for the fixed ones the exact size (0: any size from the minimum up).
inline bool PayloadOk(uint32_t type, uint32_t length)
{
	switch (type)
	{
	case kHello:
		return length == 20;
	case kSynth:
		return length >= 12 && length <= 12 + kMaxText;
	case kCancel:
	case kSetThreads:
	case kPing:
		return length == 4;
	case kShutdown:
		return length == 0;
	case kReady:
		return length == 28;
	case kChunk:
		return length >= 24;
	case kDone:
		return length == 24;
	case kError:
		return length >= 8 && length <= 8 + 512;
	case kPong:
		return length == 20;
	case kLog:
		return length <= 512;
	default:
		return false;
	}
}
} // namespace proto
} // namespace h9tts
