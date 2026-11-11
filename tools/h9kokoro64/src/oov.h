// ---- h9kokoro64: words the lexicon does not know ----------------------------------------------------------------------------
// A chat line is full of words no dictionary has (slang, names, typos). misaki hands them to espeak-ng, which the helper does not carry (it is GPL and
// needs its own data); what the helper does instead, in order, for a word the lexicon rules could not pronounce:
//   a clitic   a word that ends in n't, 's, 've, 'll, 're, 'd or 'm on a base the chain can say: the base, then the ending
//   spelling   a word with no vowel letter in it (wtf, brb, xzy) is spelled out letter by letter, as misaki does for capitals
//   the trees  letter-to-sound decision trees trained on the lexicon itself (en_us.h9lt, H9LT): one small tree for each letter looks at the letters
//              around it and says which phonemes it makes
//
// H9LT layout (little endian)
//   0   char[4] "H9LT"   4 u16 version (1)   6 u8 window W (letters looked at on each side)   7 u8 0   8 u32 nodes total   12 u32 class bytes total
//   16  u32 crc32 of the bytes [20, end)
//   20  26 x (u32 first node, u32 node count, u32 first class) for the letters a to z, then u32 classes total, (classes + 1) x u32 class offsets,
//       the class blob (u8 length, vocabulary ids; a class is the phonemes one letter makes: none, one or two symbols), padding to 4 bytes,
//       then the nodes: nodes x (u16 f, u16 aux). f 0xFFFF is a leaf and aux its class (within the letter); any other f is a yes/no question about
//       the position in the word, the answer no goes to the next node and the answer yes to this node + aux.
// The questions: the letter at offset k (k = -W..-1, +1..+W) is c; the first or second letter is c; the last, second last or third last letter is c;
// at least n vowel groups lie left of the position (1..7), or right of it (1..7); the position is at least n from the start (1..14) or from the end (1..14).
#pragma once

#include <stdint.h>

#include <string>
#include <vector>

#include "g2p_text.h"

namespace h9k
{
class LtsTrees
{
public:
	LtsTrees() : m_data(nullptr), m_size(0), m_win(0), m_nodes(0), m_classes(0) {}

	// The data must stay alive while the trees are used. False with the reason in err.
	bool Load(const uint8_t* data, size_t size, std::string* err)
	{
		m_data = nullptr;
		if (size < 20 + 26 * 12 + 4 || memcmp(data, "H9LT", 4) != 0)
			return Fail(err, "the trees are not an H9LT file");
		const uint32_t version = Rd16(data + 4);
		m_win = data[6];
		const uint32_t nodes = Rd32(data + 8), blobBytes = Rd32(data + 12), crc = Rd32(data + 16);
		if (version != 1 || m_win < 1 || m_win > 8 || nodes == 0 || nodes > 4000000)
			return Fail(err, "the trees header is not valid");
		if (Crc32(data + 20, size - 20) != crc)
			return Fail(err, "the trees checksum does not match");
		size_t p = 20 + 26 * 12;
		m_classes = Rd32(data + p);
		p += 4;
		if (m_classes == 0 || m_classes > 400000 || p + (size_t)(m_classes + 1) * 4 + blobBytes > size)
			return Fail(err, "the trees class table is out of range");
		m_clsOff = p;
		p += (size_t)(m_classes + 1) * 4;
		m_blob = p;
		m_blobBytes = blobBytes;
		p += blobBytes;
		p = (p + 3) & ~(size_t)3;
		if (p + (size_t)nodes * 4 != size)
			return Fail(err, "the trees node table does not fit the file");
		m_nodeStart = p;
		m_nodes = nodes;
		// every letter's nodes and classes lie inside the tables
		for (int c = 0; c < 26; c++)
		{
			const uint32_t first = Rd32(data + 20 + 12 * c), count = Rd32(data + 24 + 12 * c), firstClass = Rd32(data + 28 + 12 * c);
			if ((uint64_t)first + count > nodes || firstClass > m_classes)
				return Fail(err, "a letter's tree is out of range");
		}
		m_data = data;
		m_size = size;
		return true;
	}

	bool Loaded() const { return m_data != nullptr; }

	// The phonemes of a word of lower-case letters a-z (vocabulary ids); false when a tree runs off its table.
	bool Predict(const std::string& word, Ps& out) const
	{
		out.clear();
		if (!m_data || word.empty() || word.size() > 40)
			return false;
		const int n = (int)word.size();
		int codes[64];
		for (int i = 0; i < n; i++)
			codes[i] = word[(size_t)i] - 'a';
		for (int i = 0; i < n; i++)
		{
			if (codes[i] < 0 || codes[i] > 25)
				return false;
		}
		for (int i = 0; i < n; i++)
		{
			const uint8_t* lp = m_data + 20 + 12 * codes[i];
			const uint32_t firstNode = Rd32(lp), nNodes = Rd32(lp + 4), firstClass = Rd32(lp + 8);
			if (nNodes == 0)
				continue; // a letter the trees never saw makes no sound
			int lets[16];
			int k = 0;
			for (int o = -(int)m_win; o <= (int)m_win; o++)
			{
				if (o == 0)
					continue;
				const int j = i + o;
				lets[k++] = (j >= 0 && j < n) ? codes[j] : 26;
			}
			int first[2] = { codes[0], n > 1 ? codes[1] : 26 };
			int last[3];
			for (int q = 0; q < 3; q++)
				last[q] = n - 1 - q >= 0 ? codes[n - 1 - q] : 26;
			int nvl = 0, nvr = 0;
			for (int e = 0; e < i; e++)
			{
				if (IsVowel(codes, n, e) && !IsVowel(codes, n, e + 1))
					nvl++;
			}
			for (int q = i + 1; q < n; q++)
			{
				if (IsVowel(codes, n, q) && !IsVowel(codes, n, q - 1))
					nvr++;
			}
			const int vals[4] = { nvl < 7 ? nvl : 7, nvr < 7 ? nvr : 7, i < 14 ? i : 14, (n - 1 - i) < 14 ? (n - 1 - i) : 14 };
			uint32_t node = 0;
			int guard = 0;
			for (;;)
			{
				if (node >= nNodes || ++guard > 100000)
					return false;
				const uint8_t* np = m_data + m_nodeStart + (size_t)(firstNode + node) * 4;
				const uint32_t f = Rd16(np), aux = Rd16(np + 2);
				if (f == 0xFFFF)
				{
					if (!AppendClass(firstClass + aux, out))
						return false;
					break;
				}
				node = Test(f, lets, first, last, vals) ? node + aux : node + 1;
			}
		}
		return true;
	}

private:
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

	static bool IsVowel(const int* codes, int n, int k)
	{
		if (k < 0 || k >= n)
			return false;
		const int c = codes[k];
		return c == 0 || c == 4 || c == 8 || c == 14 || c == 20 || c == 24; // a e i o u y
	}

	bool Test(uint32_t f, const int* lets, const int* first, const int* last, const int* vals) const
	{
		const uint32_t nLetter = 2u * m_win * 27u;
		if (f < nLetter)
			return lets[f / 27] == (int)(f % 27);
		f -= nLetter;
		if (f < 54)
			return first[f / 27] == (int)(f % 27);
		f -= 54;
		if (f < 81)
			return last[f / 27] == (int)(f % 27);
		f -= 81;
		static const uint32_t counts[4] = { 7, 7, 14, 14 };
		for (int q = 0; q < 4; q++)
		{
			if (f < counts[q])
				return vals[q] >= (int)f + 1;
			f -= counts[q];
		}
		return false;
	}

	bool AppendClass(uint32_t k, Ps& out) const
	{
		if (k >= m_classes)
			return false;
		const uint32_t off = Rd32(m_data + m_clsOff + (size_t)k * 4);
		if (off >= m_blobBytes)
			return false;
		const uint8_t* p = m_data + m_blob + off;
		const uint32_t len = p[0];
		if (off + 1 + len > m_blobBytes)
			return false;
		out.append((const char*)p + 1, len);
		return true;
	}

	static bool Fail(std::string* err, const char* why)
	{
		if (err)
			*err = why;
		return false;
	}

	const uint8_t* m_data;
	size_t m_size;
	uint32_t m_win, m_nodes, m_classes;
	size_t m_clsOff = 0, m_blob = 0, m_nodeStart = 0;
	uint32_t m_blobBytes = 0;
};

class LtsOov : public OovChain
{
public:
	explicit LtsOov(Port& port) : m_port(port) {}

	bool LoadTrees(const uint8_t* data, size_t size, std::string* err) { return m_trees.Load(data, size, err); }
	bool HasTrees() const { return m_trees.Loaded(); }

	// text as typed; the letters are lower-cased, anything but letters and apostrophes dropped.
	Ps Phonemize(const std::string& text) override
	{
		std::string w;
		for (size_t i = 0; i < text.size(); i++)
		{
			const char c = text[i];
			if (IsAlphaC(c))
				w.push_back(IsUpperC(c) ? (char)(c + 32) : c);
			else if (c == '\'')
				w.push_back(c);
		}
		size_t a = 0, b = w.size();
		while (a < b && w[a] == '\'')
			a++;
		while (b > a && w[b - 1] == '\'')
			b--;
		w = w.substr(a, b - a);
		if (w.empty())
			return Ps();
		return WordPs(w, 0);
	}

private:
	Ps Spell(const std::string& w)
	{
		const Pron p = m_port.GetNNP(w);
		return p.present ? p.ps : Ps();
	}

	Ps WordPs(const std::string& wIn, int depth)
	{
		static const struct { const char* suf; char kind; } clitics[] = { { "n't", 'N' }, { "'ve", 'v' }, { "'ll", 'l' }, { "'re", 'r' }, { "'d", 'd' }, { "'m", 'm' }, { "'s", 's' } };
		const Syms& S = m_port.S();
		const Vocab& V = m_port.V();
		if (depth < 3)
		{
			for (size_t i = 0; i < sizeof(clitics) / sizeof(clitics[0]); i++)
			{
				const std::string suf = clitics[i].suf;
				if (EndsWith(wIn, clitics[i].suf) && wIn.size() >= suf.size() + 2)
				{
					const std::string base = wIn.substr(0, wIn.size() - suf.size());
					const Ps bps = WordPs(base, depth + 1);
					if (bps.empty())
						break;
					if (clitics[i].kind == 's')
					{
						const Ps s = m_port.SuffixS(bps);
						return s.empty() ? bps : s;
					}
					const bool lastVowel = S.Has(S.vowels, bps[bps.size() - 1]);
					const Ps schwa = V.Make(u"\u0259");
					Ps tail;
					switch (clitics[i].kind)
					{
					case 'N':
						tail = V.Make(u"\u1d4an") + Ps(1, S.tt);
						break;
					case 'v':
						tail = schwa + V.Make(u"v");
						break;
					case 'l':
						tail = lastVowel ? V.Make(u"l") : schwa + V.Make(u"l");
						break;
					case 'r':
						tail = lastVowel ? V.Make(u"\u0279") : schwa + V.Make(u"\u0279");
						break;
					case 'd':
						tail = lastVowel ? V.Make(u"d") : schwa + V.Make(u"d");
						break;
					default:
						tail = V.Make(u"m");
						break;
					}
					return bps + tail;
				}
			}
		}
		std::string w;
		for (size_t i = 0; i < wIn.size(); i++)
		{
			if (wIn[i] != '\'')
				w.push_back(wIn[i]);
		}
		if (w.empty())
			return Ps();
		if (w.find_first_of("aeiouy") == std::string::npos)
			return Spell(w);
		Ps tree;
		if (m_trees.Loaded() && m_trees.Predict(w, tree) && !tree.empty())
			return tree;
		return Spell(w);
	}

	Port& m_port;
	LtsTrees m_trees;
};
} // namespace h9k
