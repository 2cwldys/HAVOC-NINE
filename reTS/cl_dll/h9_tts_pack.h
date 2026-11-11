// ---- H9 text to speech: the line pack ---------------------------------------------------------------------------------
// A line pack (h9tts\lines\lines.h9pk) holds lines that are known ahead of time -- the bots' fixed chat, an NPC's words --
// already synthesised, one clip for each (voice, text): the raw trimmed Kokoro line, 24 kHz mono, stored as IMA ADPCM
// (4 bits a sample, 12 KB a second). The client looks a line up by its text before it asks the helper process, so a line
// that is in the pack is heard at once. The depth, the gas mask, the machine chains and the volume are not in the clip:
// they are applied on playback, as they are to a line that was just synthesised.
//
// Layout (little endian)
//   0   char[4]  "H9PK"
//   4   u16      version (1)            6  u16 sample rate of the clips (24000)
//   8   u32      count                  12 u32 offset of the index
//   16  u32      offset of the data     20 u32 file size
//   24  u32      crc32 of the bytes [28, file size)
//   28  data: the clips, one after another
//   index (count x 24 bytes, sorted by key): u64 key, u32 offset in the data, u32 samples, u32 bytes, u32 crc32 of the text
// A clip is: i16 first sample, u8 step index, u8 0, then the 4-bit codes of samples 1 .. samples-1, low nibble first.
// key = FNV-1a 64 over  voice key, '\n', cleaned text  (h9tts::PackKey).
//
// Header-only, the C library and the standard containers. The reader never trusts the file: every offset and size is
// checked against the file's size before a byte is read, and a clip is decoded into a buffer sized from its own checked
// sample count.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

namespace h9tts
{
static const int kPackRate = 24000;
static const uint32_t kPackMaxSamples = 24000u * 60u; // a clip longer than a minute is not a chat line
static const int kPackHeader = 28;
static const int kPackEntry = 24;

// ---- IMA ADPCM, mono ----------------------------------------------------------------------------------------------------

static const int kAdpcmStep[89] = { 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
	130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
	1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289,
	16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767 };
static const int kAdpcmIndex[8] = { -1, -1, -1, -1, 2, 4, 6, 8 };

struct AdpcmState
{
	int predictor;
	int index;
};

// One code for a sample, and the state after it (the decoder does exactly the same update).
inline int AdpcmStep(AdpcmState& st, int sample)
{
	const int step = kAdpcmStep[st.index];
	int diff = sample - st.predictor;
	int code = 0;
	if (diff < 0)
	{
		code = 8;
		diff = -diff;
	}
	int temp = step;
	if (diff >= temp)
	{
		code |= 4;
		diff -= temp;
	}
	temp >>= 1;
	if (diff >= temp)
	{
		code |= 2;
		diff -= temp;
	}
	temp >>= 1;
	if (diff >= temp)
		code |= 1;
	int vp = step >> 3;
	if (code & 4)
		vp += step;
	if (code & 2)
		vp += step >> 1;
	if (code & 1)
		vp += step >> 2;
	st.predictor += (code & 8) ? -vp : vp;
	if (st.predictor > 32767)
		st.predictor = 32767;
	if (st.predictor < -32768)
		st.predictor = -32768;
	st.index += kAdpcmIndex[code & 7];
	if (st.index < 0)
		st.index = 0;
	if (st.index > 88)
		st.index = 88;
	return code;
}

// Encodes n samples (n >= 1) into out: 4 + (n - 1 + 1) / 2 bytes. Returns the byte count.
inline size_t AdpcmEncode(const int16_t* pcm, int n, std::vector<uint8_t>& out)
{
	out.clear();
	AdpcmState st;
	st.predictor = pcm[0];
	st.index = 0;
	out.push_back((uint8_t)(pcm[0] & 0xFF));
	out.push_back((uint8_t)((pcm[0] >> 8) & 0xFF));
	out.push_back(0);
	out.push_back(0);
	uint8_t byte = 0;
	for (int i = 1; i < n; i++)
	{
		const int code = AdpcmStep(st, pcm[i]);
		if (i & 1)
			byte = (uint8_t)code;
		else
		{
			byte = (uint8_t)(byte | (code << 4));
			out.push_back(byte);
		}
	}
	if (n >= 2 && ((n - 1) & 1))
		out.push_back(byte);
	return out.size();
}

// The index byte of a clip's header is the step index the encoder starts with (always 0 today); the decoder reads it so that a
// differently started clip still decodes.
inline bool AdpcmDecode(const uint8_t* clip, size_t bytes, uint32_t samples, std::vector<int16_t>& out)
{
	out.clear();
	if (samples < 1 || samples > kPackMaxSamples || bytes < 4)
		return false;
	const size_t need = 4 + ((size_t)samples - 1 + 1) / 2;
	if (bytes < need)
		return false;
	AdpcmState st;
	st.predictor = (int16_t)(clip[0] | (clip[1] << 8));
	st.index = clip[2] > 88 ? 88 : clip[2];
	out.resize(samples);
	out[0] = (int16_t)st.predictor;
	const uint8_t* p = clip + 4;
	for (uint32_t i = 1; i < samples; i++)
	{
		const int code = (i & 1) ? (p[(i - 1) / 2] & 15) : (p[(i - 1) / 2] >> 4);
		const int step = kAdpcmStep[st.index];
		int vp = step >> 3;
		if (code & 4)
			vp += step;
		if (code & 2)
			vp += step >> 1;
		if (code & 1)
			vp += step >> 2;
		st.predictor += (code & 8) ? -vp : vp;
		if (st.predictor > 32767)
			st.predictor = 32767;
		if (st.predictor < -32768)
			st.predictor = -32768;
		st.index += kAdpcmIndex[code & 7];
		if (st.index < 0)
			st.index = 0;
		if (st.index > 88)
			st.index = 88;
		out[i] = (int16_t)st.predictor;
	}
	return true;
}

// ---- keys ---------------------------------------------------------------------------------------------------------------

inline uint64_t Fnv1a64(const void* data, size_t n, uint64_t h = 1469598103934665603ULL)
{
	const uint8_t* p = (const uint8_t*)data;
	for (size_t i = 0; i < n; i++)
	{
		h ^= p[i];
		h *= 1099511628211ULL;
	}
	return h;
}

struct Crc32Table
{
	uint32_t t[256];
	Crc32Table()
	{
		for (uint32_t i = 0; i < 256; i++)
		{
			uint32_t c = i;
			for (int k = 0; k < 8; k++)
				c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
			t[i] = c;
		}
	}
};

inline uint32_t Crc32(const void* data, size_t n, uint32_t crc = 0)
{
	static const Crc32Table table;
	crc = ~crc;
	const uint8_t* p = (const uint8_t*)data;
	for (size_t i = 0; i < n; i++)
		crc = table.t[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
	return ~crc;
}

// The key of a clip: the voice key (h9fx::VoiceKey), a newline, the cleaned text.
inline uint64_t PackKey(const std::string& voiceKey, const char* text, size_t textLen)
{
	uint64_t h = Fnv1a64(voiceKey.data(), voiceKey.size());
	h = Fnv1a64("\n", 1, h);
	return Fnv1a64(text, textLen, h);
}

// ---- the writer ---------------------------------------------------------------------------------------------------------

struct PackClip
{
	uint64_t key;
	uint32_t textCrc;
	uint32_t samples;
	std::vector<uint8_t> blob; // the encoded clip
};

inline void PutU16(std::vector<uint8_t>& v, uint32_t x)
{
	v.push_back((uint8_t)(x & 0xFF));
	v.push_back((uint8_t)((x >> 8) & 0xFF));
}

inline void PutU32(std::vector<uint8_t>& v, uint32_t x)
{
	for (int i = 0; i < 4; i++)
		v.push_back((uint8_t)((x >> (8 * i)) & 0xFF));
}

inline void PutU64(std::vector<uint8_t>& v, uint64_t x)
{
	for (int i = 0; i < 8; i++)
		v.push_back((uint8_t)((x >> (8 * i)) & 0xFF));
}

// The bytes of a pack file holding these clips (sorted by key here; a duplicate key keeps the first). False when there are none.
inline bool PackBuild(std::vector<PackClip> clips, std::vector<uint8_t>& file)
{
	file.clear();
	if (clips.empty())
		return false;
	for (size_t i = 1; i < clips.size(); i++)
	{
		PackClip c = clips[i];
		size_t j = i;
		while (j > 0 && clips[j - 1].key > c.key)
		{
			clips[j] = clips[j - 1];
			j--;
		}
		clips[j] = c;
	}
	std::vector<PackClip> uniq;
	for (size_t i = 0; i < clips.size(); i++)
	{
		if (uniq.empty() || uniq.back().key != clips[i].key)
			uniq.push_back(clips[i]);
	}
	std::vector<uint8_t> data, index;
	for (size_t i = 0; i < uniq.size(); i++)
	{
		PutU64(index, uniq[i].key);
		PutU32(index, (uint32_t)data.size());
		PutU32(index, uniq[i].samples);
		PutU32(index, (uint32_t)uniq[i].blob.size());
		PutU32(index, uniq[i].textCrc);
		data.insert(data.end(), uniq[i].blob.begin(), uniq[i].blob.end());
	}
	const uint32_t indexOff = (uint32_t)(kPackHeader + data.size());
	const uint32_t total = indexOff + (uint32_t)index.size();
	file.push_back('H');
	file.push_back('9');
	file.push_back('P');
	file.push_back('K');
	PutU16(file, 1);
	PutU16(file, (uint32_t)kPackRate);
	PutU32(file, (uint32_t)uniq.size());
	PutU32(file, indexOff);
	PutU32(file, (uint32_t)kPackHeader);
	PutU32(file, total);
	PutU32(file, 0); // crc, filled in below
	file.insert(file.end(), data.begin(), data.end());
	file.insert(file.end(), index.begin(), index.end());
	const uint32_t crc = Crc32(file.data() + kPackHeader, file.size() - kPackHeader);
	for (int i = 0; i < 4; i++)
		file[24 + i] = (uint8_t)((crc >> (8 * i)) & 0xFF);
	return true;
}

// ---- the reader ---------------------------------------------------------------------------------------------------------

inline uint32_t GetU32(const uint8_t* p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

inline uint64_t GetU64(const uint8_t* p)
{
	return (uint64_t)GetU32(p) | ((uint64_t)GetU32(p + 4) << 32);
}

struct PackEntry
{
	uint64_t key;
	uint32_t offset;
	uint32_t samples;
	uint32_t bytes;
	uint32_t textCrc;
};

// A pack read from a file: the header and the index are kept in memory, a clip is read from the file when it is asked for. One
// thread uses a Pack at a time (the speech worker).
class Pack
{
public:
	Pack() : m_file(nullptr), m_size(0), m_dataOff(0) {}
	~Pack() { Close(); }

	// False (with the reason in err) when the file is missing or is not a pack this reader accepts.
	bool Open(const char* path, std::string* err)
	{
		FILE* f = fopen(path, "rb");
		if (!f)
		{
			if (err)
				*err = "cannot open the line pack";
			return false;
		}
		return Attach(f, err);
	}

	// Takes over a file the caller opened ("rb"): the reader closes it, also when the file is not a pack.
	bool Attach(FILE* f, std::string* err)
	{
		Close();
		m_file = f;
		uint8_t head[kPackHeader];
		if (fread(head, 1, sizeof(head), m_file) != sizeof(head) || memcmp(head, "H9PK", 4) != 0)
			return Fail("not a line pack", err);
		const uint32_t version = (uint32_t)(head[4] | (head[5] << 8));
		const uint32_t rate = (uint32_t)(head[6] | (head[7] << 8));
		const uint32_t count = GetU32(head + 8);
		const uint32_t indexOff = GetU32(head + 12);
		m_dataOff = GetU32(head + 16);
		const uint32_t total = GetU32(head + 20);
		if (version != 1 || rate != (uint32_t)kPackRate)
			return Fail("line pack version or rate not supported", err);
		fseek(m_file, 0, SEEK_END);
		const long real = ftell(m_file);
		if (real < 0 || (uint32_t)real != total)
			return Fail("line pack size does not match its header", err);
		m_size = total;
		if (count == 0 || count > 200000u || m_dataOff != (uint32_t)kPackHeader || indexOff < m_dataOff
			|| (uint64_t)indexOff + (uint64_t)count * kPackEntry != (uint64_t)total)
			return Fail("line pack index is out of range", err);
		std::vector<uint8_t> raw((size_t)count * kPackEntry);
		fseek(m_file, (long)indexOff, SEEK_SET);
		if (fread(raw.data(), 1, raw.size(), m_file) != raw.size())
			return Fail("line pack index is cut short", err);
		m_index.resize(count);
		uint64_t prev = 0;
		for (uint32_t i = 0; i < count; i++)
		{
			const uint8_t* e = raw.data() + (size_t)i * kPackEntry;
			PackEntry& pe = m_index[i];
			pe.key = GetU64(e);
			pe.offset = GetU32(e + 8);
			pe.samples = GetU32(e + 12);
			pe.bytes = GetU32(e + 16);
			pe.textCrc = GetU32(e + 20);
			if ((i > 0 && pe.key <= prev) || pe.samples < 1 || pe.samples > kPackMaxSamples
				|| (uint64_t)pe.offset + pe.bytes > (uint64_t)(indexOff - m_dataOff) || pe.bytes < 4 + (pe.samples - 1 + 1) / 2)
				return Fail("line pack index entry is out of range", err);
			prev = pe.key;
		}
		return true;
	}

	void Close()
	{
		if (m_file)
			fclose(m_file);
		m_file = nullptr;
		m_index.clear();
	}

	bool Loaded() const { return m_file != nullptr && !m_index.empty(); }
	size_t Count() const { return m_index.size(); }

	// The decoded clip of this voice and text, or false when it is not in the pack (or the stored text checksum is not the text's).
	bool Find(const std::string& voiceKey, const char* text, std::vector<int16_t>& pcm)
	{
		if (!Loaded())
			return false;
		const size_t len = strlen(text);
		const uint64_t key = PackKey(voiceKey, text, len);
		size_t lo = 0, hi = m_index.size();
		while (lo < hi)
		{
			const size_t mid = (lo + hi) / 2;
			if (m_index[mid].key < key)
				lo = mid + 1;
			else
				hi = mid;
		}
		if (lo >= m_index.size() || m_index[lo].key != key || m_index[lo].textCrc != Crc32(text, len))
			return false;
		return At(lo, pcm);
	}

	// The decoded clip at a place of the index (the tools walk the pack with it).
	bool At(size_t place, std::vector<int16_t>& pcm)
	{
		if (!Loaded() || place >= m_index.size())
			return false;
		const PackEntry& pe = m_index[place];
		std::vector<uint8_t> blob(pe.bytes);
		if (fseek(m_file, (long)(m_dataOff + pe.offset), SEEK_SET) != 0 || fread(blob.data(), 1, blob.size(), m_file) != blob.size())
			return false;
		return AdpcmDecode(blob.data(), blob.size(), pe.samples, pcm);
	}

	// The whole file's checksum against the header's: a tool's check, too slow to run on every start of the game.
	bool Verify(const char* path)
	{
		FILE* f = fopen(path, "rb");
		if (!f)
			return false;
		std::vector<uint8_t> all;
		uint8_t buf[65536];
		size_t n;
		while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
			all.insert(all.end(), buf, buf + n);
		fclose(f);
		return all.size() > (size_t)kPackHeader && Crc32(all.data() + kPackHeader, all.size() - kPackHeader) == GetU32(all.data() + 24);
	}

private:
	bool Fail(const char* why, std::string* err)
	{
		if (err)
			*err = why;
		Close();
		return false;
	}

	FILE* m_file;
	uint32_t m_size;
	uint32_t m_dataOff;
	std::vector<PackEntry> m_index;
};
} // namespace h9tts
