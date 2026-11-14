// ---- h9kokoro64: the word-level pronunciation rules --------------------------------------------------------------------------
// What misaki's English Lexicon does with one word (misaki 0.9.4, Apache-2.0, hexgrad): given the word, its part-of-speech tag and the sound that
// follows it, the phonemes. The same logic over the H9LX data, in the symbols' vocabulary ids (one byte each), so what comes out goes to the model
// as it is. Differences from misaki, on purpose: the number words are numen's (no 'and', 10^15 and over read digit by digit) and a word the rules
// cannot do is the caller's to handle (the out-of-dictionary chain), it is not sent to espeak.
//
// Strings of phonemes are h9k::Ps. A "rating" is misaki's: 4 gold, 3 silver or spelled, 2 guessed.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <map>
#include <string>
#include <vector>

#include "lexicon.h"
#include "num_en.h"

namespace h9k
{
// ---- the vocabulary ---------------------------------------------------------------------------------------------------------

// The symbols of the Kokoro model: id by Unicode code point (all in the BMP), and back.
class Vocab
{
public:
	Vocab() : m_byCp(65536, -1) {}

	// text: one "<id> <code point>" a line (decimal), as h9tts\g2p\tokens.txt has it. False with the line number in err when it is not valid.
	bool Load(const std::string& text, std::string* err)
	{
		size_t pos = 0;
		int line = 0;
		while (pos < text.size())
		{
			size_t end = text.find('\n', pos);
			if (end == std::string::npos)
				end = text.size();
			std::string l = text.substr(pos, end - pos);
			pos = end + 1;
			line++;
			while (!l.empty() && (l[l.size() - 1] == '\r' || l[l.size() - 1] == ' '))
				l.erase(l.size() - 1);
			if (l.empty() || l[0] == '#')
				continue;
			int id = 0;
			int cp = 0;
			if (sscanf(l.c_str(), "%d %d", &id, &cp) != 2 || id < 1 || id > 254 || cp < 1 || cp > 0xFFFF)
			{
				if (err)
					*err = "tokens.txt line " + std::to_string(line) + " is not valid";
				return false;
			}
			m_byCp[(size_t)cp] = (int16_t)id;
			if ((size_t)id >= m_byId.size())
				m_byId.resize((size_t)id + 1, 0);
			m_byId[(size_t)id] = (uint16_t)cp;
			m_count++;
		}
		return m_count > 0;
	}

	// The id of a code point, or -1 when it is not a symbol.
	int Id(unsigned cp) const { return cp < 65536 ? m_byCp[cp] : -1; }
	// The code point of an id, 0 when there is none.
	unsigned Cp(int id) const { return (id > 0 && (size_t)id < m_byId.size()) ? m_byId[(size_t)id] : 0; }
	int Count() const { return m_count; }

	// A phoneme string from code points (a symbol with no id is left out).
	Ps Make(const char16_t* cps) const
	{
		Ps out;
		for (; *cps; cps++)
		{
			const int id = Id(*cps);
			if (id > 0)
				out.push_back((char)id);
		}
		return out;
	}

	// Ps -> UTF-8 text for logs and tests.
	std::string ToUtf8(const Ps& ps) const
	{
		std::string out;
		for (size_t i = 0; i < ps.size(); i++)
		{
			unsigned cp = Cp((unsigned char)ps[i]);
			if (cp == 0)
				cp = '?';
			if (cp < 0x80)
				out.push_back((char)cp);
			else if (cp < 0x800)
			{
				out.push_back((char)(0xC0 | (cp >> 6)));
				out.push_back((char)(0x80 | (cp & 0x3F)));
			}
			else
			{
				out.push_back((char)(0xE0 | (cp >> 12)));
				out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
				out.push_back((char)(0x80 | (cp & 0x3F)));
			}
		}
		return out;
	}

private:
	std::vector<int16_t> m_byCp;
	std::vector<uint16_t> m_byId;
	int m_count = 0;
};

// ---- constants --------------------------------------------------------------------------------------------------------------

struct Syms
{
	char primary, secondary; // the stress marks
	Ps vowels, consonants, taus, diphthongs, nonQuote;
	Ps sufS, sufSibilant, sufEd; // the stem ends that choose the -s and -ed endings
	char flap, glottal, tee, emdash, ellipsis, lquote, rquote;
	Ps ge;     // turned a
	Ps iPrim;  // primary stress, A
	Ps iSec;   // secondary stress, I
	Ps byI;    // b, primary stress, I
	Ps ta, tu, in_, thei, thea, am_, an_;
	char sS, sZ, dd, ii, tt, ng, tauMark, space; // s z d  i-small-cap  t  eng  the "ud" vowel mark  the space

	void Init(const Vocab& v)
	{
		primary = (char)v.Id(0x2C8);
		secondary = (char)v.Id(0x2CC);
		vowels = v.Make(u"AIOQWYaiu\u00e6\u0251\u0252\u0254\u0259\u025b\u025c\u026a\u028a\u028c\u1d7b");
		consonants = v.Make(u"bdfhjklmnpstvwz\u00f0\u014b\u0261\u0279\u027e\u0283\u0292\u02a4\u02a7\u03b8");
		taus = v.Make(u"AIOWYiu\u00e6\u0251\u0259\u025b\u026a\u0279\u028a\u028c");
		diphthongs = v.Make(u"AIOQWY\u02a4\u02a7");
		nonQuote = v.Make(u";:,.!?\u2014\u2026");
		sufS = v.Make(u"ptkf\u03b8");
		sufSibilant = v.Make(u"sz\u0283\u0292\u02a7\u02a4");
		sufEd = v.Make(u"pkf\u03b8\u0283s\u02a7");
		flap = (char)v.Id(0x27E);
		glottal = (char)v.Id(0x294);
		tee = (char)v.Id('t');
		emdash = (char)v.Id(0x2014);
		ellipsis = (char)v.Id(0x2026);
		lquote = (char)v.Id(0x201C);
		rquote = (char)v.Id(0x201D);
		ge = v.Make(u"\u0250");
		iPrim = v.Make(u"\u02c8A");
		iSec = v.Make(u"\u02ccI");
		byI = v.Make(u"b\u02c8I");
		ta = v.Make(u"t\u0259");
		tu = v.Make(u"t\u028a");
		in_ = v.Make(u"\u026an");
		thei = v.Make(u"\u00f0i");
		thea = v.Make(u"\u00f0\u0259");
		am_ = v.Make(u"\u0250m");
		an_ = v.Make(u"\u0250n");
		sS = (char)v.Id('s');
		sZ = (char)v.Id('z');
		dd = (char)v.Id('d');
		tt = (char)v.Id('t');
		ii = (char)v.Id(0x26A);
		ng = (char)v.Id(0x14B);
		tauMark = (char)v.Id(0x1D7B);
		space = (char)v.Id(' ');
	}

	bool Has(const Ps& set, char c) const { return set.find(c) != Ps::npos; }
};

// ---- the context a word is said in -----------------------------------------------------------------------------------------

struct Ctx
{
	int futureVowel = -1; // -1 none (the clause ends), 0 a consonant follows, 1 a vowel follows
	bool futureTo = false;
};

// A pronunciation and where it came from; present is false when there is none (misaki's None).
struct Pron
{
	bool present = false;
	Ps ps;
	int rating = 0;
	Pron() {}
	Pron(const Ps& p, int r) : present(true), ps(p), rating(r) {}
};

// A stress override: absent (None) or a number.
struct Stress
{
	bool present = false;
	double v = 0;
	Stress() {}
	explicit Stress(double x) : present(true), v(x) {}
};

// ---- ASCII character classes with Python's meaning for the folded text ---------------------------------------------------

inline bool IsUpperC(char c) { return c >= 'A' && c <= 'Z'; }
inline bool IsLowerC(char c) { return c >= 'a' && c <= 'z'; }
inline bool IsAlphaC(char c) { return IsUpperC(c) || IsLowerC(c); }
inline bool IsDigitC(char c) { return c >= '0' && c <= '9'; }

inline bool IsAlpha(const std::string& s)
{
	if (s.empty())
		return false;
	for (size_t i = 0; i < s.size(); i++)
	{
		if (!IsAlphaC(s[i]))
			return false;
	}
	return true;
}

inline bool IsDigits(const std::string& s)
{
	if (s.empty())
		return false;
	for (size_t i = 0; i < s.size(); i++)
	{
		if (!IsDigitC(s[i]))
			return false;
	}
	return true;
}

inline bool EndsWith(const std::string& s, const char* suf)
{
	const size_t n = strlen(suf);
	return s.size() >= n && s.compare(s.size() - n, n, suf) == 0;
}

inline bool StartsWith(const std::string& s, const char* pre)
{
	const size_t n = strlen(pre);
	return s.size() >= n && s.compare(0, n, pre) == 0;
}

// Python's str.upper() == s and s.lower() == s tests on ASCII (digits and punctuation are both).
inline bool IsAllLower(const std::string& s) { return Lexicon::Lower(s) == s; }
inline bool IsAllUpper(const std::string& s) { return Lexicon::Upper(s) == s; }

// ---- the rules --------------------------------------------------------------------------------------------------------------

class Port
{
public:
	Port(const Lexicon& lex, const Vocab& vocab) : m_lex(lex), m_vocab(vocab) { m_s.Init(vocab); }

	const Syms& S() const { return m_s; }
	const Vocab& V() const { return m_vocab; }

	// ---- dictionaries (the grown gold and silver lists), with a small cache
	const LexVal& Golds(const std::string& w)
	{
		std::map<std::string, LexVal>::iterator it = m_gold.find(w);
		if (it == m_gold.end())
		{
			LexVal v;
			m_lex.GoldGet(w, v);
			if (m_gold.size() > 4000)
				m_gold.clear();
			it = m_gold.insert(std::make_pair(w, v)).first;
		}
		return it->second;
	}

	const LexVal& Silvers(const std::string& w)
	{
		std::map<std::string, LexVal>::iterator it = m_silver.find(w);
		if (it == m_silver.end())
		{
			LexVal v;
			m_lex.SilverGet(w, v);
			if (m_silver.size() > 4000)
				m_silver.clear();
			it = m_silver.insert(std::make_pair(w, v)).first;
		}
		return it->second;
	}

	bool InGolds(const std::string& w) { return Golds(w).found; }
	bool InSilvers(const std::string& w) { return Silvers(w).found; }

	// ---- stress
	bool HasVowel(const Ps& ps) const
	{
		for (size_t i = 0; i < ps.size(); i++)
		{
			if (m_s.Has(m_s.vowels, ps[i]))
				return true;
		}
		return false;
	}

	bool HasStressMark(const Ps& ps) const { return ps.find(m_s.primary) != Ps::npos || ps.find(m_s.secondary) != Ps::npos; }

	static void ReplaceAll(Ps& ps, char from, char to)
	{
		for (size_t i = 0; i < ps.size(); i++)
		{
			if (ps[i] == from)
				ps[i] = to;
		}
	}

	static void RemoveAll(Ps& ps, char c)
	{
		Ps out;
		for (size_t i = 0; i < ps.size(); i++)
		{
			if (ps[i] != c)
				out.push_back(ps[i]);
		}
		ps = out;
	}

	// misaki apply_stress: ps is unchanged for no stress; the marks are kept, removed, moved before the first vowel or promoted by the value.
	Ps ApplyStress(const Ps& ps, const Stress& st) const
	{
		if (!st.present)
			return ps;
		const double s = st.v;
		Ps r = ps;
		const bool hasPrimary = ps.find(m_s.primary) != Ps::npos;
		const bool hasSecondary = ps.find(m_s.secondary) != Ps::npos;
		if (s < -1)
		{
			RemoveAll(r, m_s.primary);
			RemoveAll(r, m_s.secondary);
			return r;
		}
		if (s == -1 || ((s == 0 || s == -0.5) && hasPrimary))
		{
			RemoveAll(r, m_s.secondary);
			ReplaceAll(r, m_s.primary, m_s.secondary);
			return r;
		}
		if ((s == 0 || s == 0.5 || s == 1) && !hasPrimary && !hasSecondary)
		{
			if (!HasVowel(ps))
				return ps;
			return Restress(ps, m_s.secondary);
		}
		if (s >= 1 && !hasPrimary && hasSecondary)
		{
			ReplaceAll(r, m_s.secondary, m_s.primary);
			return r;
		}
		if (s > 1 && !hasPrimary && !hasSecondary)
		{
			if (!HasVowel(ps))
				return ps;
			return Restress(ps, m_s.primary);
		}
		return ps;
	}

	int StressWeight(const Ps& ps) const
	{
		int w = 0;
		for (size_t i = 0; i < ps.size(); i++)
			w += m_s.Has(m_s.diphthongs, ps[i]) ? 2 : 1;
		return w;
	}

	// ---- the tags
	static std::string ParentTag(const std::string& tag)
	{
		if (StartsWith(tag, "VB"))
			return "VERB";
		if (StartsWith(tag, "NN"))
			return "NOUN";
		if (StartsWith(tag, "ADV") || StartsWith(tag, "RB"))
			return "ADV";
		if (StartsWith(tag, "ADJ") || StartsWith(tag, "JJ"))
			return "ADJ";
		return tag;
	}

	// ---- misaki Lexicon

	Pron GetNNP(const std::string& word)
	{
		Ps joined;
		for (size_t i = 0; i < word.size(); i++)
		{
			if (!IsAlphaC(word[i]))
				continue;
			const LexVal& v = Golds(std::string(1, (char)(IsLowerC(word[i]) ? word[i] - 32 : word[i])));
			if (!v.found)
				return Pron();
			joined += PlainOf(v);
		}
		Ps ps = ApplyStress(joined, Stress(0));
		const size_t at = ps.rfind(m_s.secondary);
		if (at != Ps::npos)
			ps[at] = m_s.primary;
		return Pron(ps, 3);
	}

	Pron GetSpecialCase(const std::string& word, const std::string& tag, const Stress& stress, const Ctx& ctx)
	{
		if (tag == "ADD" && (word == "." || word == "/"))
			return Lookup(word == "." ? "dot" : "slash", "", Stress(-0.5), &ctx);
		if (word == "%" || word == "&" || word == "+" || word == "@")
			return Lookup(word == "%" ? "percent" : (word == "&" ? "and" : (word == "+" ? "plus" : "at")), "", Stress(), &ctx);
		if (word.find('.') != std::string::npos && DotsInside(word))
			return GetNNP(word);
		if (word == "a" || word == "A")
			return Pron(tag == "DT" ? m_s.ge : m_s.iPrim, 4);
		if (word == "am" || word == "Am" || word == "AM")
		{
			if (StartsWith(tag, "NN"))
				return GetNNP(word);
			if (ctx.futureVowel == -1 || word != "am" || (stress.present && stress.v != 0 && stress.v > 0))
				return Pron(PlainOf(Golds("am")), 4);
			return Pron(m_s.am_, 4);
		}
		if (word == "an" || word == "An" || word == "AN")
		{
			if (word == "AN" && StartsWith(tag, "NN"))
				return GetNNP(word);
			return Pron(m_s.an_, 4);
		}
		if (word == "I" && tag == "PRP")
			return Pron(m_s.iSec, 4);
		if ((word == "by" || word == "By" || word == "BY") && ParentTag(tag) == "ADV")
			return Pron(m_s.byI, 4);
		if (word == "to" || word == "To" || (word == "TO" && (tag == "TO" || tag == "IN")))
		{
			if (ctx.futureVowel == -1)
				return Pron(PlainOf(Golds("to")), 4);
			return Pron(ctx.futureVowel == 0 ? m_s.ta : m_s.tu, 4);
		}
		if (word == "in" || word == "In" || (word == "IN" && tag != "NNP"))
		{
			Ps ps;
			if (ctx.futureVowel == -1 || tag != "IN")
				ps.push_back(m_s.primary);
			return Pron(ps + m_s.in_, 4);
		}
		if (word == "the" || word == "The" || (word == "THE" && tag == "DT"))
			return Pron(ctx.futureVowel == 1 ? m_s.thei : m_s.thea, 4);
		if (tag == "IN" && IsVs(word))
			return Lookup("versus", "", Stress(), &ctx);
		if (word == "used" || word == "Used" || word == "USED")
		{
			const LexVal& u = Golds("used");
			const LexVal::Tag* t = u.Get((tag == "VBD" || tag == "JJ") && ctx.futureTo ? kPosVbd : kPosDefault);
			if (t && !t->none)
				return Pron(t->ps, 4);
			return Pron();
		}
		return Pron();
	}

	bool IsKnown(const std::string& word, const std::string& tag)
	{
		(void)tag;
		if (InGolds(word) || word == "%" || word == "&" || word == "+" || word == "@" || InSilvers(word))
			return true;
		if (!IsAlpha(word))
			return false;
		if (word.size() == 1)
			return true;
		if (IsAllUpper(word) && InGolds(Lexicon::Lower(word)))
			return true;
		const std::string rest = word.substr(1);
		return rest == Lexicon::Upper(rest);
	}

	Pron Lookup(std::string word, const std::string& tag, const Stress& stress, const Ctx* ctx)
	{
		bool isNnp = false;
		if (IsAllUpper(word) && !InGolds(word))
		{
			word = Lexicon::Lower(word);
			isNnp = tag == "NNP";
		}
		LexVal ps = Golds(word);
		int rating = 4;
		if (!ps.found && !isNnp)
		{
			ps = Silvers(word);
			rating = 3;
		}
		Ps chosen;
		bool have = false;
		if (ps.found)
		{
			if (!ps.pos)
			{
				chosen = ps.plain;
				have = true;
			}
			else
			{
				int tagId;
				if (ctx && ctx->futureVowel == -1 && ps.Get(kPosNone))
					tagId = kPosNone;
				else
				{
					tagId = PosTagId(tag);
					if (tagId < 0 || !ps.Get(tagId))
					{
						tagId = PosTagId(ParentTag(tag));
						if (tagId < 0)
							tagId = kPosDefault;
					}
				}
				const LexVal::Tag* t = ps.Get(tagId);
				if (!t)
					t = ps.Get(kPosDefault);
				if (t && !t->none)
				{
					chosen = t->ps;
					have = true;
				}
			}
		}
		if (!have || (isNnp && chosen.find(m_s.primary) == Ps::npos))
		{
			const Pron nnp = GetNNP(word);
			if (nnp.present)
				return nnp;
		}
		if (!have)
			return Pron();
		return Pron(ApplyStress(chosen, stress), rating);
	}

	Ps SuffixS(const Ps& stem) const
	{
		if (stem.empty())
			return Ps();
		const char last = stem[stem.size() - 1];
		if (m_s.Has(m_s.sufS, last))
			return stem + m_s.sS;
		if (m_s.Has(m_s.sufSibilant, last))
			return stem + m_s.tauMark + m_s.sZ;
		return stem + m_s.sZ;
	}

	Pron StemS(const std::string& word, const std::string& tag, const Stress& stress, const Ctx* ctx)
	{
		if (word.size() < 3 || !EndsWith(word, "s"))
			return Pron();
		std::string stem;
		if (!EndsWith(word, "ss") && IsKnown(word.substr(0, word.size() - 1), tag))
			stem = word.substr(0, word.size() - 1);
		else if ((EndsWith(word, "'s") || (word.size() > 4 && EndsWith(word, "es") && !EndsWith(word, "ies"))) && IsKnown(word.substr(0, word.size() - 2), tag))
			stem = word.substr(0, word.size() - 2);
		else if (word.size() > 4 && EndsWith(word, "ies") && IsKnown(word.substr(0, word.size() - 3) + "y", tag))
			stem = word.substr(0, word.size() - 3) + "y";
		else
			return Pron();
		const Pron p = Lookup(stem, tag, stress, ctx);
		if (!p.present)
			return Pron();
		const Ps s = SuffixS(p.ps);
		return s.empty() ? Pron() : Pron(s, p.rating);
	}

	Ps SuffixEd(const Ps& stem) const
	{
		if (stem.empty())
			return Ps();
		const char last = stem[stem.size() - 1];
		if (m_s.Has(m_s.sufEd, last))
			return stem + m_s.tt;
		if (last == m_s.dd)
			return stem + m_s.tauMark + m_s.dd;
		if (last != m_s.tt)
			return stem + m_s.dd;
		if (stem.size() < 2)
			return stem + m_s.ii + m_s.dd;
		if (m_s.Has(m_s.taus, stem[stem.size() - 2]))
			return stem.substr(0, stem.size() - 1) + m_s.flap + m_s.tauMark + m_s.dd;
		return stem + m_s.tauMark + m_s.dd;
	}

	Pron StemEd(const std::string& word, const std::string& tag, const Stress& stress, const Ctx* ctx)
	{
		if (word.size() < 4 || !EndsWith(word, "d"))
			return Pron();
		std::string stem;
		if (!EndsWith(word, "dd") && IsKnown(word.substr(0, word.size() - 1), tag))
			stem = word.substr(0, word.size() - 1);
		else if (word.size() > 4 && EndsWith(word, "ed") && !EndsWith(word, "eed") && IsKnown(word.substr(0, word.size() - 2), tag))
			stem = word.substr(0, word.size() - 2);
		else
			return Pron();
		const Pron p = Lookup(stem, tag, stress, ctx);
		if (!p.present)
			return Pron();
		const Ps s = SuffixEd(p.ps);
		return s.empty() ? Pron() : Pron(s, p.rating);
	}

	Ps SuffixIng(const Ps& stem) const
	{
		if (stem.empty())
			return Ps();
		if (stem.size() > 1 && stem[stem.size() - 1] == m_s.tt && m_s.Has(m_s.taus, stem[stem.size() - 2]))
			return stem.substr(0, stem.size() - 1) + m_s.flap + m_s.ii + m_s.ng;
		return stem + m_s.ii + m_s.ng;
	}

	Pron StemIng(const std::string& word, const std::string& tag, const Stress& stress, const Ctx* ctx)
	{
		if (word.size() < 5 || !EndsWith(word, "ing"))
			return Pron();
		std::string stem;
		if (word.size() > 5 && IsKnown(word.substr(0, word.size() - 3), tag))
			stem = word.substr(0, word.size() - 3);
		else if (IsKnown(word.substr(0, word.size() - 3) + "e", tag))
			stem = word.substr(0, word.size() - 3) + "e";
		else if (word.size() > 5 && DoubledBeforeIng(word) && IsKnown(word.substr(0, word.size() - 4), tag))
			stem = word.substr(0, word.size() - 4);
		else
			return Pron();
		const Pron p = Lookup(stem, tag, stress, ctx);
		if (!p.present)
			return Pron();
		const Ps s = SuffixIng(p.ps);
		return s.empty() ? Pron() : Pron(s, p.rating);
	}

	Pron GetWord(std::string word, const std::string& tag, const Stress& stress, const Ctx& ctx)
	{
		Pron sp = GetSpecialCase(word, tag, stress, ctx);
		if (sp.present)
			return sp;
		const std::string wl = Lexicon::Lower(word);
		if (word.size() > 1 && IsAlpha(Without(word, '\'')) && word != wl && (tag != "NNP" || word.size() > 7) && !InGolds(word) && !InSilvers(word)
			&& (IsAllUpper(word) || word.substr(1) == Lexicon::Lower(word.substr(1))))
		{
			bool rescue = InGolds(wl) || InSilvers(wl);
			if (!rescue)
			{
				const Pron a = StemS(wl, tag, stress, &ctx);
				const Pron b = StemEd(wl, tag, stress, &ctx);
				const Pron c = StemIng(wl, tag, stress, &ctx);
				rescue = (a.present && !a.ps.empty()) || (b.present && !b.ps.empty()) || (c.present && !c.ps.empty());
			}
			if (rescue)
				word = wl;
		}
		if (IsKnown(word, tag))
			return Lookup(word, tag, stress, &ctx);
		if (EndsWith(word, "s'") && IsKnown(word.substr(0, word.size() - 2) + "'s", tag))
			return Lookup(word.substr(0, word.size() - 2) + "'s", tag, stress, &ctx);
		if (EndsWith(word, "'") && IsKnown(word.substr(0, word.size() - 1), tag))
			return Lookup(word.substr(0, word.size() - 1), tag, stress, &ctx);
		Pron r = StemS(word, tag, stress, &ctx);
		if (r.present)
			return r;
		r = StemEd(word, tag, stress, &ctx);
		if (r.present)
			return r;
		return StemIng(word, tag, stress.present ? stress : Stress(0.5), &ctx);
	}

	// ---- numbers

	static bool IsNumber(const std::string& word, bool isHead)
	{
		if (word.find_first_of("0123456789") == std::string::npos)
			return false;
		std::string w = word;
		static const char* suffixes[] = { "ing", "'d", "ed", "'s", "st", "nd", "rd", "th", "s" };
		for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++)
		{
			if (EndsWith(w, suffixes[i]))
			{
				w = w.substr(0, w.size() - strlen(suffixes[i]));
				break;
			}
		}
		for (size_t i = 0; i < w.size(); i++)
		{
			const char c = w[i];
			if (!(IsDigitC(c) || c == ',' || c == '.' || (isHead && i == 0 && c == '-')))
				return false;
		}
		return true;
	}

	Pron GetNumber(const std::string& wordIn, const std::string& currency, bool isHead)
	{
		std::string word = wordIn;
		// the lower-case suffix: [a-z']+$
		size_t sufStart = word.size();
		while (sufStart > 0 && (IsLowerC(word[sufStart - 1]) || word[sufStart - 1] == '\''))
			sufStart--;
		const std::string suffix = word.substr(sufStart);
		word = word.substr(0, sufStart);
		const bool ordinal = suffix == "st" || suffix == "nd" || suffix == "rd" || suffix == "th";
		const bool curr = currency == "$" || currency == "\x01" || currency == "\x02";
		std::vector<Pron> result;
		if (StartsWith(word, "-"))
		{
			result.push_back(Lookup("minus", "", Stress(), nullptr));
			word = word.substr(1);
		}
		if (IsDigits(word) && ordinal)
			Extend(result, word, 'o');
		else if (result.empty() && word.size() == 4 && !curr && IsDigits(word))
			Extend(result, word, 'y');
		else if (!isHead && word.find('.') == std::string::npos)
		{
			const std::string num = Without(word, ',');
			if (num.empty())
				return Pron();
			if (num[0] == '0' || num.size() > 3)
			{
				for (size_t i = 0; i < num.size(); i++)
					Extend(result, std::string(1, num[i]), 'c');
			}
			else if (num.size() == 3 && !EndsWith(num, "00"))
			{
				Extend(result, num.substr(0, 1), 'c');
				if (num[1] == '0')
				{
					result.push_back(Lookup("O", "", Stress(-2), nullptr));
					Extend(result, num.substr(2), 'c');
				}
				else
					Extend(result, num.substr(1), 'c');
			}
			else
				Extend(result, num, 'c');
		}
		else if (Count(word, '.') > 1 || !isHead)
		{
			const std::string flat = Without(word, ',');
			size_t from = 0;
			while (from <= flat.size())
			{
				size_t dot = flat.find('.', from);
				if (dot == std::string::npos)
					dot = flat.size();
				const std::string num = flat.substr(from, dot - from);
				from = dot + 1;
				if (num.empty())
					continue;
				bool restNonZero = false;
				for (size_t k = 1; k < num.size(); k++)
				{
					if (num[k] != '0')
						restNonZero = true;
				}
				if (num[0] == '0' || (num.size() != 2 && restNonZero))
				{
					for (size_t k = 0; k < num.size(); k++)
						Extend(result, std::string(1, num[k]), 'c');
				}
				else
					Extend(result, num, 'c');
			}
		}
		else if (curr && IsCurrencyAmount(word))
			CurrencyWords(result, word, currency);
		else
			PlainNumber(result, word, ordinal);
		return Finish(result, suffix);
	}

	Ps AppendCurrency(const Ps& ps, const std::string& currency)
	{
		if (currency.empty())
			return ps;
		const char* unit = currency == "$" ? "dollar" : (currency == "\x01" ? "pound" : (currency == "\x02" ? "euro" : nullptr));
		if (!unit)
			return ps;
		const Pron s = StemS(std::string(unit) + "s", "", Stress(), nullptr);
		if (!s.present || s.ps.empty())
			return ps;
		return ps + m_s.space + s.ps;
	}

	// misaki Lexicon.__call__ for a token of ASCII text.
	Pron Call(const std::string& text, const std::string& tag, const Ctx& ctx, const Stress& stressOverride, const std::string& currency, bool isHead)
	{
		const std::string word = text;
		Stress stress;
		if (word != Lexicon::Lower(word))
			stress = Stress(word == Lexicon::Upper(word) ? 2.0 : 0.5);
		Pron p = GetWord(word, tag, stress, ctx);
		if (p.present)
			return Pron(ApplyStress(AppendCurrency(p.ps, currency), stressOverride), p.rating);
		if (IsNumber(word, isHead))
		{
			p = GetNumber(word, currency, isHead);
			if (!p.present)
				return Pron();
			return Pron(ApplyStress(p.ps, stressOverride), p.rating);
		}
		return Pron();
	}

private:
	// The plain string of a value (a POS record gives its DEFAULT).
	static Ps PlainOf(const LexVal& v)
	{
		if (!v.pos)
			return v.plain;
		const LexVal::Tag* t = v.Get(kPosDefault);
		return (t && !t->none) ? t->ps : Ps();
	}

	// Inserts the stress mark before the first vowel of a string that has no mark (misaki restress of  mark + ps).
	Ps Restress(const Ps& ps, char mark) const
	{
		for (size_t i = 0; i < ps.size(); i++)
		{
			if (m_s.Has(m_s.vowels, ps[i]))
				return ps.substr(0, i) + mark + ps.substr(i);
		}
		return ps;
	}

	static std::string Without(const std::string& s, char c)
	{
		std::string r;
		for (size_t i = 0; i < s.size(); i++)
		{
			if (s[i] != c)
				r.push_back(s[i]);
		}
		return r;
	}

	static int Count(const std::string& s, char c)
	{
		int n = 0;
		for (size_t i = 0; i < s.size(); i++)
		{
			if (s[i] == c)
				n++;
		}
		return n;
	}

	// word contains an inner '.', only letters otherwise, and every dotted part is under 3 letters ("U.S.A", "e.g")
	static bool DotsInside(const std::string& word)
	{
		size_t a = 0, b = word.size();
		while (a < b && word[a] == '.')
			a++;
		while (b > a && word[b - 1] == '.')
			b--;
		if (word.substr(a, b - a).find('.') == std::string::npos)
			return false;
		const std::string letters = Without(word, '.');
		if (!IsAlpha(letters))
			return false;
		size_t longest = 0, from = 0;
		while (from <= word.size())
		{
			size_t dot = word.find('.', from);
			if (dot == std::string::npos)
				dot = word.size();
			if (dot - from > longest)
				longest = dot - from;
			from = dot + 1;
		}
		return longest < 3;
	}

	static bool IsVs(const std::string& word)
	{
		const std::string l = Lexicon::Lower(word);
		return l == "vs" || l == "vs.";
	}

	static bool DoubledBeforeIng(const std::string& word)
	{
		if (word.size() < 5)
			return false;
		const std::string tail = word.substr(word.size() - 5);
		if (tail == "cking")
			return true;
		static const char* set = "bcdgklmnprstvxz";
		return tail[0] == tail[1] && strchr(set, tail[0]) != nullptr && tail[0] != 0;
	}

	// ---- number words

	numen::Words WordsOf(const std::string& digits, char mode) const
	{
		size_t z = 0;
		while (z + 1 < digits.size() && digits[z] == '0')
			z++;
		const std::string d = digits.substr(z);
		if (d.size() > 15)
			return numen::DigitWords(d);
		uint64_t n = 0;
		for (size_t i = 0; i < d.size(); i++)
			n = n * 10 + (uint64_t)(d[i] - '0');
		if (mode == 'o')
			return numen::Ordinal(n);
		if (mode == 'y')
			return numen::Year((int)n);
		return numen::Cardinal(n);
	}

	void AddWords(std::vector<Pron>& result, const numen::Words& ws)
	{
		for (size_t i = 0; i < ws.size(); i++)
			result.push_back(Lookup(ws[i], "", ws[i] == "point" ? Stress(-2) : Stress(), nullptr));
	}

	void Extend(std::vector<Pron>& result, const std::string& digits, char mode)
	{
		AddWords(result, WordsOf(digits, mode));
	}

	void CurrencyWords(std::vector<Pron>& result, const std::string& word, const std::string& currency)
	{
		const char* unit1 = currency == "$" ? "dollar" : (currency == "\x01" ? "pound" : "euro");
		const char* unit2 = currency == "$" ? "cent" : (currency == "\x01" ? "pence" : "cent");
		const std::string flat = Without(word, ',');
		const size_t dot = flat.find('.');
		struct P { uint64_t n; const char* unit; };
		std::vector<P> pairs;
		P a = { 0, unit1 };
		const std::string ip = flat.substr(0, dot == std::string::npos ? flat.size() : dot);
		for (size_t i = 0; i < ip.size() && ip.size() <= 15; i++)
			a.n = a.n * 10 + (uint64_t)(ip[i] - '0');
		pairs.push_back(a);
		if (dot != std::string::npos)
		{
			P b = { 0, unit2 };
			const std::string fp = flat.substr(dot + 1);
			for (size_t i = 0; i < fp.size() && fp.size() <= 15; i++)
				b.n = b.n * 10 + (uint64_t)(fp[i] - '0');
			pairs.push_back(b);
		}
		if (pairs.size() > 1)
		{
			if (pairs[1].n == 0)
				pairs.pop_back();
			else if (pairs[0].n == 0)
				pairs.erase(pairs.begin());
		}
		for (size_t i = 0; i < pairs.size(); i++)
		{
			if (i > 0)
				result.push_back(Lookup("and", "", Stress(), nullptr));
			AddWords(result, numen::Cardinal(pairs[i].n));
			if (pairs[i].n != 1 && std::string(pairs[i].unit) != "pence")
				result.push_back(StemS(std::string(pairs[i].unit) + "s", "", Stress(), nullptr));
			else
				result.push_back(Lookup(pairs[i].unit, "", Stress(), nullptr));
		}
	}

	// misaki Lexicon.is_currency: no dot, or one dot with fewer than three digits after it.
	static bool IsCurrencyAmount(const std::string& word)
	{
		const size_t dot = word.find('.');
		if (dot == std::string::npos)
			return true;
		if (Count(word, '.') > 1)
			return false;
		return word.size() - dot - 1 < 3;
	}

	// The last branch of get_number: a plain cardinal or ordinal, or a decimal. word holds digits, commas and at most one dot.
	void PlainNumber(std::vector<Pron>& result, std::string word, bool ordinal)
	{
		if (IsDigits(word))
			AddWords(result, WordsOf(word, 'c'));
		else if (word.find('.') == std::string::npos)
			AddWords(result, WordsOf(Without(word, ','), ordinal ? 'o' : 'c'));
		else
		{
			word = Without(word, ',');
			if (!word.empty() && word[0] == '.')
			{
				numen::Words w;
				w.push_back("point");
				const numen::Words d = numen::DigitWords(word.substr(1));
				w.insert(w.end(), d.begin(), d.end());
				AddWords(result, w);
			}
			else
			{
				const size_t dot = word.find('.');
				const std::string ip = word.substr(0, dot), fp = word.substr(dot + 1);
				if (ip.size() + fp.size() <= 15)
					AddWords(result, numen::DecimalWords(ip, fp));
				else
				{
					numen::Words w = numen::DigitWords(ip);
					w.push_back("point");
					const numen::Words d = numen::DigitWords(fp);
					w.insert(w.end(), d.begin(), d.end());
					AddWords(result, w);
				}
			}
		}
	}

	Pron Finish(const std::vector<Pron>& result, const std::string& suffix)
	{
		if (result.empty())
			return Pron();
		Ps joined;
		int rating = 99;
		for (size_t i = 0; i < result.size(); i++)
		{
			if (!result[i].present)
				return Pron();
			if (i)
				joined.push_back(m_s.space);
			joined += result[i].ps;
			if (result[i].rating < rating)
				rating = result[i].rating;
		}
		if (suffix == "s" || suffix == "'s")
		{
			const Ps r = SuffixS(joined);
			return r.empty() ? Pron() : Pron(r, rating);
		}
		if (suffix == "ed" || suffix == "'d")
		{
			const Ps r = SuffixEd(joined);
			return r.empty() ? Pron() : Pron(r, rating);
		}
		if (suffix == "ing")
		{
			const Ps r = SuffixIng(joined);
			return r.empty() ? Pron() : Pron(r, rating);
		}
		return Pron(joined, rating);
	}

	const Lexicon& m_lex;
	const Vocab& m_vocab;
	Syms m_s;
	std::map<std::string, LexVal> m_gold, m_silver;
};
} // namespace h9k
