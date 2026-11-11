// ---- h9kokoro64: the pronunciation lexicon -----------------------------------------------------------------------------
// h9tts\g2p\en_us.h9lex (H9LX): the gold and silver pronunciation lists of misaki (Apache-2.0, hexgrad) in one compact file. The keys are the
// lower-case words with the case variants misaki's grow_dictionary makes (lower, Capitalized, UPPER) folded into one entry; the values are strings
// of Kokoro vocabulary ids, one byte for each symbol. Words with several pronunciations (a noun and a verb: "record") have a part-of-speech record.
//
// Layout (little endian)
//   0   char[4] "H9LX"   4 u16 version (1)   6 u16 accent (0 US, 1 GB)   8 u32 nKeys   12 u32 blockSize   16 u32 nBlocks   20 u32 offBlockIndex
//   24  u32 nMixed   28 u32 offMixed   32 u32 fileSize   36 u32 crc32 of the bytes [40, fileSize)   40 data
//   a block holds blockSize entries: u8 shared, u8 slen, u8 suffix[slen] (key = previous key[:shared] + suffix), u8 flags, then the values the flags name:
//     GL gold (lower-case form), GC gold (Capitalized, its own value), GU gold (UPPER, its own value), SL silver
//   flags: 1 GL present, 2 GC equals GL, 4 GC own value, 8 GU own value, 16 SL present, 32 GL is a POS record, 64 GC is, 128 GU is
//   value = u8 len, symbols  (plain)   |   u8 nTags, nTags x (u8 tag id, u8 len or 0xFF for none, symbols)  (POS record, the first tag is DEFAULT)
//   the mixed table holds the keys whose case is none of the three: nMixed x (u8 klen, key, u8 isPOS, value), exact match only
//
// The reader works on a memory block and checks every offset against its size; a damaged file is refused when it is loaded or reads as "not found".
#pragma once

#include <stdint.h>
#include <string.h>

#include <string>
#include <vector>

namespace h9k
{
typedef std::string Ps; // symbols as Kokoro vocabulary ids, one byte each

// The part-of-speech tags a record can be keyed by (the order is the file's).
enum PosTag { kPosDefault = 0, kPosNoun, kPosVerb, kPosAdj, kPosNone, kPosVbd, kPosAdv, kPosVbn, kPosVbp, kPosDt, kPosCount };

inline int PosTagId(const std::string& tag)
{
	static const char* names[kPosCount] = { "DEFAULT", "NOUN", "VERB", "ADJ", "None", "VBD", "ADV", "VBN", "VBP", "DT" };
	for (int i = 0; i < kPosCount; i++)
	{
		if (tag == names[i])
			return i;
	}
	return -1;
}

struct LexVal
{
	bool found = false;
	bool pos = false;
	Ps plain;
	struct Tag
	{
		int tag;
		bool none; // the record says "no pronunciation" for this tag
		Ps ps;
	};
	std::vector<Tag> tags;

	const Tag* Get(int tag) const
	{
		for (size_t i = 0; i < tags.size(); i++)
		{
			if (tags[i].tag == tag)
				return &tags[i];
		}
		return nullptr;
	}
};

class Lexicon
{
public:
	Lexicon() : m_data(nullptr), m_size(0), m_n(0), m_blockSize(0), m_nBlocks(0), m_offIndex(0), m_nMixed(0), m_offMixed(0), m_accent(0) {}

	// The data must stay alive and unchanged while the lexicon is used (the caller owns it). False with the reason in err.
	bool Load(const uint8_t* data, size_t size, std::string* err)
	{
		if (size < 40 || memcmp(data, "H9LX", 4) != 0)
			return Fail(err, "the lexicon is not an H9LX file");
		const uint32_t version = Rd16(data + 4);
		m_accent = Rd16(data + 6);
		m_n = Rd32(data + 8);
		m_blockSize = Rd32(data + 12);
		m_nBlocks = Rd32(data + 16);
		m_offIndex = Rd32(data + 20);
		m_nMixed = Rd32(data + 24);
		m_offMixed = Rd32(data + 28);
		const uint32_t total = Rd32(data + 32);
		const uint32_t crc = Rd32(data + 36);
		if (version != 1 || total != size || m_blockSize == 0 || m_blockSize > 4096 || m_nBlocks == 0 || m_n == 0)
			return Fail(err, "the lexicon header is not valid");
		if ((uint64_t)m_offIndex + (uint64_t)m_nBlocks * 4 > size || m_offMixed > size || m_offIndex < 40
			|| (uint64_t)m_nBlocks * m_blockSize < m_n || (uint64_t)(m_nBlocks - 1) * m_blockSize >= m_n)
			return Fail(err, "the lexicon index is out of range");
		if (Crc32(data + 40, size - 40) != crc)
			return Fail(err, "the lexicon checksum does not match");
		m_data = data;
		m_size = size;
		return true;
	}

	bool Loaded() const { return m_data != nullptr; }
	uint32_t Keys() const { return m_n; }

	// misaki's grown gold dictionary: the entry for this exact word (any of the case forms), or not found.
	bool GoldGet(const std::string& word, LexVal& out) const
	{
		out = LexVal();
		if (!m_data)
			return false;
		const std::string lk = Lower(word), cap = Capitalize(lk), up = Upper(lk);
		if (word == lk || word == cap || word == up)
		{
			Entry e;
			if (!Find(lk, e))
				return false;
			if (word == lk)
				return (e.flags & 1) ? ReadValue(e.gl, (e.flags & 32) != 0, out) : false;
			if (word == cap)
			{
				if (e.flags & 2)
					return (e.flags & 1) ? ReadValue(e.gl, (e.flags & 32) != 0, out) : false;
				return (e.flags & 4) ? ReadValue(e.gc, (e.flags & 64) != 0, out) : false;
			}
			return (e.flags & 8) ? ReadValue(e.gu, (e.flags & 128) != 0, out) : false;
		}
		return MixedGet(word, out);
	}

	// misaki's grown silver dictionary: lower-case or Capitalized words only.
	bool SilverGet(const std::string& word, LexVal& out) const
	{
		out = LexVal();
		if (!m_data)
			return false;
		const std::string lk = Lower(word);
		if (word != lk && word != Capitalize(lk))
			return false;
		Entry e;
		if (!Find(lk, e) || !(e.flags & 16))
			return false;
		return ReadValue(e.sl, false, out);
	}

	// ASCII case helpers with Python's meaning for the words the lexicon sees.
	static std::string Lower(const std::string& s)
	{
		std::string r = s;
		for (size_t i = 0; i < r.size(); i++)
		{
			if (r[i] >= 'A' && r[i] <= 'Z')
				r[i] = (char)(r[i] + 32);
		}
		return r;
	}
	static std::string Upper(const std::string& s)
	{
		std::string r = s;
		for (size_t i = 0; i < r.size(); i++)
		{
			if (r[i] >= 'a' && r[i] <= 'z')
				r[i] = (char)(r[i] - 32);
		}
		return r;
	}
	static std::string Capitalize(const std::string& s)
	{
		std::string r = Lower(s);
		if (!r.empty() && r[0] >= 'a' && r[0] <= 'z')
			r[0] = (char)(r[0] - 32);
		return r;
	}

private:
	struct Entry
	{
		uint8_t flags;
		const uint8_t* gl;
		const uint8_t* gc;
		const uint8_t* gu;
		const uint8_t* sl;
	};

	static uint32_t Rd16(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8); }
	static uint32_t Rd32(const uint8_t* p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

	static uint32_t Crc32(const uint8_t* p, size_t n)
	{
		static uint32_t table[256];
		static bool made = false;
		if (!made)
		{
			for (uint32_t i = 0; i < 256; i++)
			{
				uint32_t c = i;
				for (int k = 0; k < 8; k++)
					c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
				table[i] = c;
			}
			made = true;
		}
		uint32_t crc = 0xFFFFFFFFu;
		for (size_t i = 0; i < n; i++)
			crc = table[(crc ^ p[i]) & 0xFF] ^ (crc >> 8);
		return ~crc;
	}

	const uint8_t* End() const { return m_data + m_size; }

	// The offset of a block: from the index, checked.
	const uint8_t* BlockStart(uint32_t bi) const
	{
		const uint8_t* ip = m_data + m_offIndex + (size_t)bi * 4;
		const uint32_t off = Rd32(ip);
		if (off < 40 || off >= m_size)
			return nullptr;
		return m_data + off;
	}

	// The first key of a block (its first entry has shared 0).
	bool BlockFirstKey(uint32_t bi, std::string& key) const
	{
		const uint8_t* p = BlockStart(bi);
		if (!p || p + 2 > End())
			return false;
		const uint32_t slen = p[1];
		if (p + 2 + slen > End())
			return false;
		key.assign((const char*)p + 2, slen);
		return true;
	}

	// Skips a value (plain or POS record); null when the data is cut short.
	const uint8_t* SkipValue(const uint8_t* p, bool pos) const
	{
		if (p >= End())
			return nullptr;
		if (!pos)
		{
			const uint8_t* q = p + 1 + p[0];
			return q <= End() ? q : nullptr;
		}
		const uint32_t nt = p[0];
		p++;
		for (uint32_t i = 0; i < nt; i++)
		{
			if (p + 2 > End())
				return nullptr;
			const uint32_t len = p[1];
			p += 2;
			if (len != 0xFF)
				p += len;
			if (p > End())
				return nullptr;
		}
		return p;
	}

	bool ReadValue(const uint8_t* p, bool pos, LexVal& out) const
	{
		out = LexVal();
		if (!p || p >= End())
			return false;
		if (!pos)
		{
			const uint32_t len = p[0];
			if (p + 1 + len > End())
				return false;
			out.found = true;
			out.plain.assign((const char*)p + 1, len);
			return true;
		}
		const uint32_t nt = p[0];
		p++;
		out.pos = true;
		for (uint32_t i = 0; i < nt; i++)
		{
			if (p + 2 > End())
				return false;
			LexVal::Tag t;
			t.tag = p[0];
			const uint32_t len = p[1];
			p += 2;
			t.none = len == 0xFF;
			if (!t.none)
			{
				if (p + len > End())
					return false;
				t.ps.assign((const char*)p, len);
				p += len;
			}
			out.tags.push_back(t);
		}
		out.found = !out.tags.empty();
		return out.found;
	}

	// The entry of a lower-case key: a binary search over the blocks' first keys, then a scan inside one block.
	bool Find(const std::string& lk, Entry& e) const
	{
		uint32_t lo = 0, hi = m_nBlocks - 1;
		std::string key;
		while (lo < hi)
		{
			const uint32_t mid = (lo + hi + 1) / 2;
			if (!BlockFirstKey(mid, key))
				return false;
			if (key <= lk)
				lo = mid;
			else
				hi = mid - 1;
		}
		const uint8_t* p = BlockStart(lo);
		if (!p)
			return false;
		const uint32_t count = (lo + 1 == m_nBlocks) ? (m_n - lo * m_blockSize) : m_blockSize;
		key.clear();
		for (uint32_t i = 0; i < count; i++)
		{
			if (p + 3 > End())
				return false;
			const uint32_t shared = p[0], slen = p[1];
			if (shared > key.size() || p + 2 + slen + 1 > End())
				return false;
			key.resize(shared);
			key.append((const char*)p + 2, slen);
			p += 2 + slen;
			const uint8_t flags = *p++;
			const uint8_t* start = p;
			e.flags = flags;
			e.gl = e.gc = e.gu = e.sl = nullptr;
			if (key == lk)
			{
				if (flags & 1)
				{
					e.gl = p;
					p = SkipValue(p, (flags & 32) != 0);
					if (!p)
						return false;
				}
				if (flags & 4)
				{
					e.gc = p;
					p = SkipValue(p, (flags & 64) != 0);
					if (!p)
						return false;
				}
				if (flags & 8)
				{
					e.gu = p;
					p = SkipValue(p, (flags & 128) != 0);
					if (!p)
						return false;
				}
				if (flags & 16)
					e.sl = p;
				(void)start;
				return true;
			}
			if (key > lk)
				return false;
			p = start;
			if (flags & 1)
				p = SkipValue(p, (flags & 32) != 0);
			if (p && (flags & 4))
				p = SkipValue(p, (flags & 64) != 0);
			if (p && (flags & 8))
				p = SkipValue(p, (flags & 128) != 0);
			if (p && (flags & 16))
				p = SkipValue(p, false);
			if (!p)
				return false;
		}
		return false;
	}

	bool MixedGet(const std::string& word, LexVal& out) const
	{
		const uint8_t* p = m_data + m_offMixed;
		for (uint32_t i = 0; i < m_nMixed; i++)
		{
			if (p + 2 > End())
				return false;
			const uint32_t kl = p[0];
			if (p + 1 + kl + 1 > End())
				return false;
			const bool same = kl == word.size() && memcmp(p + 1, word.data(), kl) == 0;
			p += 1 + kl;
			const bool pos = *p++ != 0;
			if (same)
				return ReadValue(p, pos, out);
			p = SkipValue(p, pos);
			if (!p)
				return false;
		}
		return false;
	}

	static bool Fail(std::string* err, const char* why)
	{
		if (err)
			*err = why;
		return false;
	}

	const uint8_t* m_data;
	size_t m_size;
	uint32_t m_n, m_blockSize, m_nBlocks, m_offIndex, m_nMixed, m_offMixed, m_accent;
};
} // namespace h9k
