// ---- h9kokoro64: from a chat line to phonemes ---------------------------------------------------------------------------
// The line-level part of the G2P (misaki 0.9.4, Apache-2.0, hexgrad, reduced to rules): the text is folded to ASCII, cut into words and punctuation the
// way a tokenizer would (what spaCy gives misaki, without spaCy), tagged with the few part-of-speech tags the lexicon cares about, said from the last
// word to the first so that each word knows what follows it (a vowel, a consonant, the end of the clause), and the stress of words that were made of
// several parts is balanced. A word the rules cannot pronounce goes to the out-of-dictionary chain (an OovChain), alone.
//
// The result is a phoneme string in vocabulary ids: spaces and punctuation as the model wants them, the flap and the glottal stop rewritten as the
// model knows them (misaki does the same at the end).
#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "fold_table.h"
#include "g2p_core.h"

namespace h9k
{
// What the line-level G2P asks for a word the lexicon rules do not know. text is the word as typed (ASCII). An empty result says nothing is spoken for it.
class OovChain
{
public:
	virtual ~OovChain() {}
	virtual Ps Phonemize(const std::string& text) = 0;
};

// ---- text helpers --------------------------------------------------------------------------------------------------------------

inline bool IsPunctWord(const char c) { return strchr(";:,.!?", c) != nullptr && c != 0; }

// UTF-8 to ASCII: Latin letters lose their marks, typographic punctuation becomes plain, control characters become spaces, the pound and euro
// signs become the control characters 1 and 2, everything else is dropped.
inline std::string FoldText(const std::string& in)
{
	std::string out;
	size_t i = 0;
	while (i < in.size())
	{
		const unsigned char c = (unsigned char)in[i];
		unsigned cp = 0;
		size_t len = 1;
		if (c < 0x80)
			cp = c;
		else if ((c & 0xE0) == 0xC0 && i + 1 < in.size() && ((unsigned char)in[i + 1] & 0xC0) == 0x80)
		{
			cp = ((unsigned)(c & 0x1F) << 6) | ((unsigned char)in[i + 1] & 0x3F);
			len = 2;
		}
		else if ((c & 0xF0) == 0xE0 && i + 2 < in.size() && ((unsigned char)in[i + 1] & 0xC0) == 0x80 && ((unsigned char)in[i + 2] & 0xC0) == 0x80)
		{
			cp = ((unsigned)(c & 0x0F) << 12) | ((unsigned)((unsigned char)in[i + 1] & 0x3F) << 6) | ((unsigned char)in[i + 2] & 0x3F);
			len = 3;
		}
		else if ((c & 0xF8) == 0xF0 && i + 3 < in.size())
		{
			cp = 0x10000; // outside the table: dropped
			len = 4;
		}
		else
		{
			cp = 0; // a stray byte: dropped
			len = 1;
		}
		i += len;
		if (cp == 0)
			continue;
		if (cp < 0x80)
		{
			if (cp < 32 || cp == 127)
				out.push_back(' ');
			else
				out.push_back((char)cp);
			continue;
		}
		if (cp >= 0xFF01 && cp < 0xFF5F)
		{
			out.push_back((char)(cp - 0xFEE0));
			continue;
		}
		int lo = 0, hi = kFoldCount - 1;
		while (lo <= hi)
		{
			const int mid = (lo + hi) / 2;
			if (kFoldTable[mid].cp == cp)
			{
				out += kFoldTable[mid].to;
				break;
			}
			if (kFoldTable[mid].cp < cp)
				lo = mid + 1;
			else
				hi = mid - 1;
		}
	}
	return out;
}

// misaki's subtokenize over ASCII text: the alternatives of its regular expression, tried in order at each position.
class Scanner
{
public:
	static bool Unit(const std::string& s, size_t k, size_t& len)
	{
		const size_t n = s.size();
		len = 0;
		if (k < n && IsDigitC(s[k]))
		{
			if (k + 2 < n && (s[k + 1] == ',' || s[k + 1] == '.') && IsDigitC(s[k + 2]))
				len = 3;
			else if (k + 1 < n && IsDigitC(s[k + 1]))
				len = 2;
			else
				len = 1;
			return true;
		}
		if (k + 1 < n && (s[k] == ',' || s[k] == '.') && IsDigitC(s[k + 1]))
		{
			len = 2;
			return true;
		}
		return false;
	}

	// The end of alternative 6 (a lower-case letter followed by an upper-case one: the camelCase cut) starting at i, or -1.
	static int Alt6End(const std::string& s, size_t i)
	{
		const size_t n = s.size();
		for (size_t e = i + 1; e < n; e++)
		{
			if (!(IsLowerC(s[e - 1]) && IsUpperC(s[e])))
				continue;
			// s[i : e-1] must be letters* ('letter)*
			size_t k = i;
			const size_t m = e - 1;
			while (k < m && IsAlphaC(s[k]))
				k++;
			while (k < m)
			{
				if (s[k] == '\'' && k + 1 < m && IsAlphaC(s[k + 1]))
					k += 2;
				else
					break;
			}
			if (k == m)
				return (int)e;
		}
		return -1;
	}

	static std::vector<std::string> Subtokenize(const std::string& s)
	{
		std::vector<std::string> out;
		const size_t n = s.size();
		size_t i = 0;
		while (i < n)
		{
			const char c = s[i];
			// 1 leading apostrophes
			if (i == 0 && c == '\'')
			{
				size_t j = i;
				while (j < n && s[j] == '\'')
					j++;
				out.push_back(s.substr(i, j - i));
				i = j;
				continue;
			}
			// 2 an upper-case letter before Upper + lower
			if (IsUpperC(c) && i + 2 < n && IsUpperC(s[i + 1]) && IsLowerC(s[i + 2]))
			{
				out.push_back(std::string(1, c));
				i++;
				continue;
			}
			// 3 a number
			size_t j = i;
			size_t len = 0;
			if (i == 0 && c == '-' && Unit(s, 1, len))
				j = 1;
			if (Unit(s, j, len))
			{
				while (Unit(s, j, len))
					j += len;
				out.push_back(s.substr(i, j - i));
				i = j;
				continue;
			}
			// 4 hyphens and underscores
			if (c == '-' || c == '_')
			{
				j = i;
				while (j < n && (s[j] == '-' || s[j] == '_'))
					j++;
				out.push_back(s.substr(i, j - i));
				i = j;
				continue;
			}
			// 5 two or more apostrophes
			if (c == '\'' && i + 1 < n && s[i + 1] == '\'')
			{
				j = i;
				while (j < n && s[j] == '\'')
					j++;
				out.push_back(s.substr(i, j - i));
				i = j;
				continue;
			}
			// 6 the camelCase cut
			if (IsAlphaC(c) || (c == '\'' && i + 1 < n && IsAlphaC(s[i + 1])))
			{
				const int e = Alt6End(s, i);
				if (e > 0)
				{
					out.push_back(s.substr(i, (size_t)e - i));
					i = (size_t)e;
					continue;
				}
			}
			// 7 a word with inner apostrophes
			if (IsAlphaC(c))
			{
				j = i;
				while (j < n && IsAlphaC(s[j]))
					j++;
				while (j + 1 < n && s[j] == '\'' && IsAlphaC(s[j + 1]))
					j += 2;
				out.push_back(s.substr(i, j - i));
				i = j;
				continue;
			}
			// 8 any other single character
			if (c != '-' && c != '_' && c != '\'' && !IsAlphaC(c) && !IsDigitC(c))
			{
				out.push_back(std::string(1, c));
				i++;
				continue;
			}
			// 9 trailing apostrophes
			if (c == '\'')
			{
				j = i;
				while (j < n && s[j] == '\'')
					j++;
				if (j == n)
				{
					out.push_back(s.substr(i, j - i));
					i = j;
					continue;
				}
			}
			i++; // matches nothing: skipped
		}
		return out;
	}
};

// ---- tokens ------------------------------------------------------------------------------------------------------------------

struct Tok
{
	std::string text, tag, ws;
	bool hasPs = false;
	Ps ps;
	bool head = true;
	bool hasAlias = false;
	std::string alias;
	Stress stress;
	std::string currency; // "" for none; "$", "\x01" (pound) or "\x02" (euro)
	bool prespace = false;

	Tok() {}
	Tok(const std::string& t, const char* g) : text(t), tag(g) {}
};

struct Word
{
	bool group = false;
	std::vector<Tok> toks; // one for a single word
};

class G2P
{
public:
	G2P(const Lexicon& lex, const Vocab& vocab, OovChain* oov) : m_port(lex, vocab), m_oov(oov) {}

	Port& P() { return m_port; }
	void SetOov(OovChain* oov) { m_oov = oov; }

	// The phonemes of a line, one string of vocabulary ids (spaces and punctuation included). Empty when nothing is speakable.
	Ps Phonemize(const std::string& utf8, int* oovWords = nullptr)
	{
		m_oovCount = 0;
		std::vector<Tok> toks = Tokenize(utf8);
		TagTokens(toks);
		std::vector<Word> words = Retokenize(toks);
		Ctx ctx;
		const Syms& S = m_port.S();
		for (int i = (int)words.size() - 1; i >= 0; i--)
		{
			Word& w = words[(size_t)i];
			if (!w.group)
			{
				Tok& t = w.toks[0];
				if (!t.hasPs)
				{
					const Pron p = Lexicon_(t, ctx);
					if (p.present)
					{
						t.hasPs = true;
						t.ps = p.ps;
					}
				}
				if (!t.hasPs)
				{
					t.ps = Fallback(t.text);
					t.hasPs = true;
				}
				ctx = TokenContext(ctx, t.ps, t);
				continue;
			}
			std::vector<Tok>& g = w.toks;
			size_t left = 0, right = g.size();
			while (left < right)
			{
				bool blocked = false;
				for (size_t k = left; k < right; k++)
				{
					if (g[k].hasAlias || g[k].hasPs)
						blocked = true;
				}
				Pron p;
				Tok merged;
				if (!blocked)
				{
					merged = MergeTokens(std::vector<Tok>(g.begin() + (long)left, g.begin() + (long)right), false);
					p = Lexicon_(merged, ctx);
				}
				if (p.present)
				{
					g[left].hasPs = true;
					g[left].ps = p.ps;
					for (size_t k = left + 1; k < right; k++)
					{
						g[k].hasPs = true;
						g[k].ps.clear();
					}
					ctx = TokenContext(ctx, p.ps, merged);
					right = left;
					left = 0;
				}
				else if (left + 1 < right)
					left++;
				else
				{
					right--;
					Tok& t = g[right];
					if (!t.hasPs)
					{
						if (AllJunk(t.text))
						{
							t.hasPs = true;
							t.ps.clear();
						}
						else if (t.text.size() == 1 && IsPunctWord(t.text[0]))
						{
							t.hasPs = true;
							t.ps = Ascii(t.text);
						}
						else
						{
							t.ps = Fallback(t.text);
							t.hasPs = true;
							ctx = TokenContext(ctx, t.ps, t);
						}
					}
					left = 0;
				}
			}
			ResolveTokens(g);
		}
		Ps out;
		for (size_t i = 0; i < words.size(); i++)
		{
			Tok t = words[i].group ? MergeTokens(words[i].toks, true) : words[i].toks[0];
			Ps ps = t.hasPs ? t.ps : Ps();
			Port::ReplaceAll(ps, S.flap, (char)m_port.V().Id('T'));
			Port::ReplaceAll(ps, S.glottal, S.tee);
			out += ps;
			out += Ascii(t.ws);
		}
		if (oovWords)
			*oovWords = m_oovCount;
		return out;
	}

private:
	// ---- helpers
	Ps Ascii(const std::string& s) const
	{
		Ps out;
		for (size_t i = 0; i < s.size(); i++)
		{
			const int id = m_port.V().Id((unsigned char)s[i]);
			if (id > 0)
				out.push_back((char)id);
		}
		return out;
	}

	static bool AllJunk(const std::string& s)
	{
		for (size_t i = 0; i < s.size(); i++)
		{
			if (strchr("',-._/", s[i]) == nullptr || s[i] == 0)
				return false;
		}
		return true;
	}

	Ps Fallback(const std::string& text)
	{
		m_oovCount++;
		if (!m_oov)
			return Ps();
		return m_oov->Phonemize(text);
	}

	bool Known(const std::string& w) { return m_port.InGolds(w) || m_port.InSilvers(w); }

	Pron Lexicon_(const Tok& t, const Ctx& ctx)
	{
		const std::string& word = t.hasAlias ? t.alias : t.text;
		return m_port.Call(word, t.tag, ctx, t.stress, t.currency, t.head);
	}

	Ctx TokenContext(const Ctx& ctx, const Ps& ps, const Tok& token) const
	{
		const Syms& S = m_port.S();
		Ctx r;
		r.futureVowel = ctx.futureVowel;
		for (size_t i = 0; i < ps.size(); i++)
		{
			const char c = ps[i];
			const bool v = S.Has(S.vowels, c), k = S.Has(S.consonants, c), n = S.Has(S.nonQuote, c);
			if (v || k || n)
			{
				r.futureVowel = n ? -1 : (v ? 1 : 0);
				break;
			}
		}
		r.futureTo = token.text == "to" || token.text == "To" || (token.text == "TO" && (token.tag == "TO" || token.tag == "IN"));
		return r;
	}

	static int CurrencyRank(const std::string& c) { return c == "\x02" ? 3 : (c == "\x01" ? 2 : (c == "$" ? 1 : 0)); }

	// misaki merge_tokens: the group's pieces as one token (with unk == true, the merged phonemes too).
	Tok MergeTokens(const std::vector<Tok>& toks, bool withPs) const
	{
		const Syms& S = m_port.S();
		Stress stress;
		int stressCount = 0;
		double sv = 0;
		std::string currency;
		for (size_t i = 0; i < toks.size(); i++)
		{
			if (toks[i].stress.present)
			{
				bool seen = stressCount > 0 && sv == toks[i].stress.v;
				if (!seen)
				{
					stressCount++;
					sv = toks[i].stress.v;
				}
			}
			if (!toks[i].currency.empty() && CurrencyRank(toks[i].currency) > CurrencyRank(currency))
				currency = toks[i].currency;
		}
		Tok m;
		if (withPs)
		{
			m.hasPs = true;
			for (size_t i = 0; i < toks.size(); i++)
			{
				const Tok& t = toks[i];
				if (t.prespace && !m.ps.empty() && m.ps[m.ps.size() - 1] != S.space && t.hasPs && !t.ps.empty())
					m.ps.push_back(S.space);
				m.ps += t.hasPs ? t.ps : Ps();
			}
		}
		size_t best = 0;
		int bestScore = -1;
		for (size_t i = 0; i < toks.size(); i++)
		{
			int score = 0;
			for (size_t k = 0; k < toks[i].text.size(); k++)
				score += IsUpperC(toks[i].text[k]) ? 2 : 1;
			if (score > bestScore)
			{
				bestScore = score;
				best = i;
			}
		}
		for (size_t i = 0; i + 1 < toks.size(); i++)
			m.text += toks[i].text + toks[i].ws;
		m.text += toks[toks.size() - 1].text;
		m.tag = toks[best].tag;
		m.ws = toks[toks.size() - 1].ws;
		m.head = toks[0].head;
		if (stressCount == 1)
			m.stress = Stress(sv);
		m.currency = currency;
		m.prespace = toks[0].prespace;
		return m;
	}

	// ---- tokenizer

	static bool IsPrefixPeel(char c) { return c != 0 && strchr("([{\"<*~|#", c) != nullptr; }
	static bool IsSuffixPeel(char c) { return c != 0 && strchr(")]}>\",;:!?*~|", c) != nullptr; }
	static bool IsInnerSplit(char c) { return c != 0 && strchr(",;!?()[]{}\"<>|~*#", c) != nullptr; }
	static bool IsCurrencyChar(char c) { return c == '$' || c == '\x01' || c == '\x02'; }

	static bool InList(const std::string& s, const char* const* list, size_t n)
	{
		for (size_t i = 0; i < n; i++)
		{
			if (s == list[i])
				return true;
		}
		return false;
	}

	static bool IsExcApos(const std::string& lower)
	{
		static const char* const l[] = { "'bout", "'cause", "'em", "'cos", "'coz", "'cuz", "'til", "'till", "'n'" };
		return InList(lower, l, sizeof(l) / sizeof(l[0]));
	}

	static bool IsKeepDot(const std::string& s)
	{
		static const char* const l[] = { "Mr.", "Mrs.", "Ms.", "Dr.", "vs.", "Vs." };
		return InList(s, l, sizeof(l) / sizeof(l[0]));
	}

	static bool IsAbbrev(const std::string& core)
	{
		// U.S.A. / e.g. / a.m. : letters separated by single periods
		if (core.size() < 3 || core[core.size() - 1] != '.')
			return false;
		const std::string body = core.substr(0, core.size() - 1);
		int parts = 0;
		size_t from = 0;
		while (from <= body.size())
		{
			size_t dot = body.find('.', from);
			if (dot == std::string::npos)
				dot = body.size();
			if (dot - from != 1 || !IsAlphaC(body[from]))
				return false;
			parts++;
			from = dot + 1;
		}
		return parts >= 2;
	}

	static bool IsEmoticon(const std::string& core)
	{
		const size_t n = core.size();
		if (n < 2 || n > 3)
			return false;
		if (strchr(":;=8", core[0]) && strchr(")(DPpOo/|*3\\", core[n - 1]) && (n == 2 || strchr("-^o'", core[1])))
			return true;
		static const char* const l[] = { "<3", "xD", "XD", "^^", "^_^", "-_-", "o_O", "O_o", "T_T", ">:(", ":'(" };
		return InList(core, l, sizeof(l) / sizeof(l[0]));
	}

	static bool LooksLikeUrl(const std::string& core)
	{
		const std::string l = Lexicon::Lower(core);
		if (core.find('@') != std::string::npos || StartsWith(l, "http") || StartsWith(l, "www."))
			return true;
		static const char* const ends[] = { ".com", ".org", ".net", ".gg", ".io", ".tv", ".us", ".uk", ".de", ".fr", ".co", ".me", ".info", ".edu", ".gov" };
		for (size_t i = 0; i < sizeof(ends) / sizeof(ends[0]); i++)
		{
			if (EndsWith(l, ends[i]) || l.find(std::string(ends[i]) + "/") != std::string::npos)
				return true;
		}
		return false;
	}

	static bool IsNumberLike(const std::string& core)
	{
		bool digit = false;
		for (size_t i = 0; i < core.size(); i++)
		{
			if (IsDigitC(core[i]))
				digit = true;
		}
		if (!digit)
			return false;
		size_t end = core.size();
		while (end > 0 && strchr("stndrhS'", core[end - 1]) != nullptr && core[end - 1] != 0)
			end--;
		for (size_t i = 0; i < end; i++)
		{
			if (!(IsDigitC(core[i]) || strchr(",.-+", core[i]) != nullptr))
				return false;
		}
		return true;
	}

	Tok PunctToken(char ch, bool opening) const
	{
		const Syms& S = m_port.S();
		Tok t(std::string(1, ch), "NFP");
		t.hasPs = true;
		if (ch == '"' || ch == '\'')
		{
			t.tag = opening ? "``" : "''";
			t.ps = Ps(1, opening ? S.lquote : S.rquote);
		}
		else if (strchr(".,!?:;", ch) && ch != 0)
		{
			t.tag = (ch == '.' || ch == ',') ? std::string(1, ch) : ".";
			t.ps = Ascii(std::string(1, ch));
		}
		else if (ch == '(')
		{
			t.tag = "-LRB-";
			t.ps = Ascii("(");
		}
		else if (ch == ')')
		{
			t.tag = "-RRB-";
			t.ps = Ascii(")");
		}
		return t;
	}

	std::vector<Tok> CoreTokens(const std::string& core)
	{
		struct Seg { bool punct; std::string v; };
		std::vector<Seg> segs;
		std::string cur;
		for (size_t ci = 0; ci < core.size(); ci++)
		{
			const char ch = core[ci];
			if (ch == ',' && ci > 0 && ci + 1 < core.size() && IsDigitC(core[ci - 1]) && IsDigitC(core[ci + 1]))
				cur += ch;
			else if (IsInnerSplit(ch))
			{
				if (!cur.empty())
				{
					Seg s = { false, cur };
					segs.push_back(s);
					cur.clear();
				}
				Seg p = { true, std::string(1, ch) };
				segs.push_back(p);
			}
			else
				cur += ch;
		}
		if (!cur.empty())
		{
			Seg s = { false, cur };
			segs.push_back(s);
		}
		std::vector<Tok> out;
		for (size_t i = 0; i < segs.size(); i++)
		{
			if (segs[i].punct)
				out.push_back(PunctToken(segs[i].v[0], out.empty()));
			else
			{
				Tok t(segs[i].v, "NN");
				if (segs[i].v == "=")
				{
					t.hasAlias = true;
					t.alias = "equals";
				}
				else if (segs[i].v == "/")
				{
					t.hasAlias = true;
					t.alias = "slash";
				}
				else if (segs[i].v == "<3")
				{
					t.hasAlias = true;
					t.alias = "heart";
				}
				out.push_back(t);
			}
		}
		return out;
	}

	std::vector<Tok> Tokenize(const std::string& utf8)
	{
		const std::string folded = FoldText(utf8);
		std::vector<std::string> pieces;
		{
			size_t i = 0;
			while (i < folded.size())
			{
				while (i < folded.size() && (folded[i] == ' ' || folded[i] == '\t'))
					i++;
				size_t j = i;
				while (j < folded.size() && folded[j] != ' ' && folded[j] != '\t')
					j++;
				if (j > i)
					pieces.push_back(folded.substr(i, j - i));
				i = j;
			}
		}
		bool quoteOpen = false;
		std::vector<Tok> toks;
		const Syms& S = m_port.S();
		for (size_t pi = 0; pi < pieces.size(); pi++)
		{
			const std::string ws = pi + 1 == pieces.size() ? "" : " ";
			std::vector<Tok> prefix, suffix;
			std::string core = pieces[pi];
			// prefix punctuation
			while (!core.empty())
			{
				const char ch = core[0];
				if (IsCurrencyChar(ch) && core.size() > 1)
				{
					Tok t(std::string(1, ch), "$");
					prefix.push_back(t);
					core = core.substr(1);
				}
				else if (IsPrefixPeel(ch))
				{
					bool opening = true;
					if (core.size() == 1 && ch == '"')
					{
						quoteOpen = !quoteOpen;
						opening = quoteOpen;
					}
					prefix.push_back(PunctToken(ch, opening));
					core = core.substr(1);
				}
				else if (ch == '\'' && core.size() > 1 && !Known(core) && !IsExcApos(Lexicon::Lower(core)))
				{
					prefix.push_back(PunctToken('\'', true));
					core = core.substr(1);
				}
				else if (StartsWith(core, "..") && core.size() > 2 && core.find_first_not_of('.') != std::string::npos)
				{
					const size_t run = core.find_first_not_of('.');
					Tok t(core.substr(0, run), "NFP");
					t.hasPs = true;
					t.ps = Ascii(core.substr(0, run));
					prefix.push_back(t);
					core = core.substr(run);
				}
				else
					break;
			}
			// suffix punctuation (a run of periods is an ellipsis token)
			while (!core.empty())
			{
				const char ch = core[core.size() - 1];
				if (ch == '.' && core.size() > 1)
				{
					if (IsKeepDot(core) || IsAbbrev(core))
						break;
					size_t end = core.size();
					while (end > 0 && core[end - 1] == '.')
						end--;
					const size_t run = core.size() - end;
					if (run >= 2 && run < core.size())
					{
						Tok t(core.substr(core.size() - run), "NFP");
						t.hasPs = true;
						t.ps = Ascii(core.substr(core.size() - run));
						suffix.push_back(t);
						core = core.substr(0, core.size() - run);
					}
					else
					{
						suffix.push_back(PunctToken('.', false));
						core = core.substr(0, core.size() - 1);
					}
				}
				else if (IsSuffixPeel(ch) && core.size() > 1)
				{
					suffix.push_back(PunctToken(ch, false));
					core = core.substr(0, core.size() - 1);
				}
				else if (ch == '\'' && core.size() > 2 && core[core.size() - 2] != 's' && core[core.size() - 2] != 'S' && !Known(core)
					&& Known(core.substr(0, core.size() - 1)))
				{
					suffix.push_back(PunctToken('\'', false));
					core = core.substr(0, core.size() - 1);
				}
				else
					break;
			}
			std::reverse(suffix.begin(), suffix.end());
			std::vector<Tok> out = prefix;
			if (!core.empty())
			{
				bool allPunct = true, allDots = true;
				for (size_t k = 0; k < core.size(); k++)
				{
					if (!strchr(".,;:!?-_'\"()[]{}<>*#~|^\\/=+&%@$", core[k]) || core[k] == 0)
						allPunct = false;
					if (core[k] != '.')
						allDots = false;
				}
				if (IsEmoticon(core))
				{
				}
				else if (core == "-")
				{
					Tok t("-", ":");
					t.hasPs = true;
					t.ps = Ps(1, S.emdash);
					out.push_back(t);
				}
				else if (core == "..." || core == ".." || core == "...." || allDots)
				{
					Tok t(core, "NFP");
					t.hasPs = true;
					t.ps = Ascii(core);
					out.push_back(t);
				}
				else if (allPunct && core.size() <= 3 && core != "&" && core != "+" && core != "=" && core != "@" && core != "%" && core != "/")
				{
					for (size_t k = 0; k < core.size(); k++)
						out.push_back(PunctToken(core[k], out.empty()));
				}
				else
				{
					std::vector<Tok> ct = CoreTokens(core);
					if (LooksLikeUrl(core))
					{
						for (size_t k = 0; k < ct.size(); k++)
						{
							if (!ct[k].hasPs)
								ct[k].tag = "ADD";
						}
					}
					out.insert(out.end(), ct.begin(), ct.end());
				}
			}
			out.insert(out.end(), suffix.begin(), suffix.end());
			if (!out.empty())
				out[out.size() - 1].ws = ws;
			toks.insert(toks.end(), out.begin(), out.end());
		}
		if (!toks.empty())
			toks[toks.size() - 1].ws = "";
		return toks;
	}

	// ---- tags: the few that matter to the lexicon

	static bool InSet(const std::string& w, const char* list)
	{
		// a space separated list
		const std::string l = std::string(" ") + list + " ";
		return l.find(" " + w + " ") != std::string::npos;
	}

	static bool IsDeterminer(const std::string& w)
	{
		return InSet(w, "the a an this that these those my your his her its our their some any no each every another both all which");
	}

	static bool IsVerbCue(const std::string& w)
	{
		return InSet(w, "to can could will would should must may might shall do does did dont doesnt didnt wont cant cannot lets let please i you we they he she it who just then and");
	}

	static bool IsAdjBeforeNoun(const std::string& w) { return InSet(w, "good bad new old big small next last first other same own"); }

	static bool IsClauseStarter(const std::string& w)
	{
		return InSet(w, "i you he she it we they was is were are will would can could has had have did does do the a an all just not then there here my your his her our their");
	}

	static bool IsSayVerb(const std::string& w)
	{
		return InSet(w, "said say says think thinks thought know knows knew hope believe means mean decided decreed guess bet heard");
	}

	bool PsIsOneOf(const Tok& t, const char* chars) const
	{
		if (!t.hasPs || t.ps.size() != 1)
			return false;
		for (const char* c = chars; *c; c++)
		{
			if (t.ps == Ascii(std::string(1, *c)))
				return true;
		}
		return false;
	}

	void TagTokens(std::vector<Tok>& toks)
	{
		std::vector<size_t> words;
		for (size_t i = 0; i < toks.size(); i++)
		{
			if (!toks[i].hasPs)
				words.push_back(i);
		}
		for (size_t k = 0; k < words.size(); k++)
		{
			const size_t i = words[k];
			Tok& t = toks[i];
			const std::string prev = k > 0 ? Lexicon::Lower(toks[words[k - 1]].text) : "";
			const std::string nxt = k + 1 < words.size() ? Lexicon::Lower(toks[words[k + 1]].text) : "";
			std::string lw = Lexicon::Lower(t.text);
			if (EndsWith(lw, ".") && lw.size() > 2 && lw.substr(0, lw.size() - 1) == "vs")
				lw = "vs";
			const bool adjPrevPunct = i > 0 && PsIsOneOf(toks[i - 1], ".!?,:;");
			const bool adjNextPunct = i + 1 < toks.size() && (PsIsOneOf(toks[i + 1], ".!?,:;") || (toks[i + 1].hasPs && toks[i + 1].ps == Ascii("...")));
			const bool clauseStart = k == 0 || adjPrevPunct;
			if (t.tag == "ADD" || t.tag == "$")
				continue;
			if (IsNumberLike(t.text))
				t.tag = "CD";
			else if (t.text == "I")
				t.tag = "PRP";
			else if (lw == "a")
				t.tag = "DT";
			else if (lw == "that" || lw == "that's" || lw == "thats")
			{
				const bool endNext = adjNextPunct || k + 1 == words.size();
				if (lw != "that")
					t.tag = "DT";
				else if (prev == "roger")
					t.tag = "IN";
				else if (k == 0 || endNext)
					t.tag = "DT";
				else if (IsClauseStarter(nxt) || IsSayVerb(prev))
					t.tag = "IN";
				else
					t.tag = "DT";
			}
			else if (InSet(lw, "in on at of for with from by than vs about into over under after before"))
				t.tag = "IN";
			else if (lw == "to")
				t.tag = "TO";
			else if (lw == "am")
				t.tag = (!prev.empty() && IsNumberLike(prev)) ? "NN" : "VBP";
			else if (lw == "used")
				t.tag = "VBD";
			else if (IsDeterminer(lw))
				t.tag = "DT";
			else if (IsUpperC(t.text[0]) && t.text.size() > 1 && t.text.substr(1) == Lexicon::Lower(t.text.substr(1)) && !clauseStart)
				t.tag = "NNP";
			else
			{
				const LexVal& pos = m_port.Golds(lw);
				if (pos.found && pos.pos)
				{
					if (lw == "read" && (prev == "i" || prev == "you" || prev == "we" || prev == "they"))
						t.tag = "VBD";
					else if (IsDeterminer(prev) || IsAdjBeforeNoun(prev))
						t.tag = "NN";
					else if (IsVerbCue(prev) || clauseStart)
						t.tag = "VB";
					else
						t.tag = "XX";
				}
				else if (EndsWith(lw, "ly"))
					t.tag = "RB";
				else
					t.tag = "XX";
			}
		}
	}

	// ---- retokenize (misaki G2P.retokenize)
	std::vector<Word> Retokenize(const std::vector<Tok>& toks)
	{
		std::vector<Word> words;
		std::string currency;
		for (size_t i = 0; i < toks.size(); i++)
		{
			const Tok& token = toks[i];
			std::vector<Tok> subs;
			if (!token.hasAlias && !token.hasPs)
			{
				const std::vector<std::string> parts = Scanner::Subtokenize(token.text);
				for (size_t p = 0; p < parts.size(); p++)
				{
					Tok n(parts[p], token.tag.c_str());
					n.stress = token.stress;
					subs.push_back(n);
				}
				if (subs.empty())
					continue;
			}
			else
				subs.push_back(token);
			subs[subs.size() - 1].ws = token.ws;
			for (size_t j = 0; j < subs.size(); j++)
			{
				Tok& tk = subs[j];
				if (tk.hasAlias || tk.hasPs)
				{
				}
				else if (tk.tag == "$" && tk.text.size() == 1 && IsCurrencyChar(tk.text[0]))
				{
					currency = tk.text;
					tk.hasPs = true;
					tk.ps.clear();
				}
				else if (!currency.empty())
				{
					if (tk.tag != "CD")
						currency.clear();
					else if (j + 1 == subs.size() && (i + 1 == toks.size() || toks[i + 1].tag != "CD"))
						tk.currency = currency;
				}
				else if (j > 0 && j + 1 < subs.size() && tk.text == "2" && IsAlphaC(subs[j - 1].text[subs[j - 1].text.size() - 1]) && IsAlphaC(subs[j + 1].text[0]))
				{
					tk.hasAlias = true;
					tk.alias = "to";
				}
				if (tk.hasAlias || tk.hasPs)
				{
					Word w;
					w.toks.push_back(tk);
					words.push_back(w);
				}
				else if (!words.empty() && words.back().group && words.back().toks.back().ws.empty())
				{
					tk.head = false;
					words.back().toks.push_back(tk);
				}
				else
				{
					Word w;
					w.toks.push_back(tk);
					w.group = tk.ws.empty();
					words.push_back(w);
				}
			}
		}
		// a group of one is a single word
		for (size_t i = 0; i < words.size(); i++)
		{
			if (words[i].group && words[i].toks.size() == 1)
				words[i].group = false;
		}
		return words;
	}

	// ---- stress of a word made of several parts (misaki resolve_tokens)
	void ResolveTokens(std::vector<Tok>& tokens)
	{
		const Syms& S = m_port.S();
		std::string text;
		for (size_t i = 0; i + 1 < tokens.size(); i++)
			text += tokens[i].text + tokens[i].ws;
		text += tokens[tokens.size() - 1].text;
		bool seen[3] = { false, false, false };
		for (size_t i = 0; i < text.size(); i++)
		{
			const char c = text[i];
			if (strchr("',-._/", c) != nullptr && c != 0)
				continue;
			seen[IsAlphaC(c) ? 0 : (IsDigitC(c) ? 1 : 2)] = true;
		}
		const int kinds = (seen[0] ? 1 : 0) + (seen[1] ? 1 : 0) + (seen[2] ? 1 : 0);
		const bool prespace = text.find(' ') != std::string::npos || text.find('/') != std::string::npos || kinds > 1;
		for (size_t i = 0; i < tokens.size(); i++)
		{
			Tok& tk = tokens[i];
			if (!tk.hasPs)
			{
				if (i + 1 == tokens.size() && tk.text.size() == 1 && IsPunctWord(tk.text[0]))
				{
					tk.hasPs = true;
					tk.ps = Ascii(tk.text);
				}
				else if (AllJunk(tk.text))
				{
					tk.hasPs = true;
					tk.ps.clear();
				}
			}
			else if (i > 0)
				tk.prespace = prespace;
		}
		if (prespace)
			return;
		struct Item { bool primary; int weight; size_t index; };
		std::vector<Item> items;
		for (size_t i = 0; i < tokens.size(); i++)
		{
			if (tokens[i].hasPs && !tokens[i].ps.empty())
			{
				Item it = { tokens[i].ps.find(S.primary) != Ps::npos, m_port.StressWeight(tokens[i].ps), i };
				items.push_back(it);
			}
		}
		if (items.size() == 2 && tokens[items[0].index].text.size() == 1)
		{
			Tok& t = tokens[items[1].index];
			t.ps = m_port.ApplyStress(t.ps, Stress(-0.5));
			return;
		}
		int primaries = 0;
		for (size_t i = 0; i < items.size(); i++)
			primaries += items[i].primary ? 1 : 0;
		if (items.size() < 2 || (size_t)primaries <= (items.size() + 1) / 2)
			return;
		// the half with the smallest (has primary, weight, index) is demoted to secondary stress
		for (size_t a = 1; a < items.size(); a++)
		{
			const Item cur = items[a];
			size_t b = a;
			while (b > 0 && (items[b - 1].primary > cur.primary || (items[b - 1].primary == cur.primary
				&& (items[b - 1].weight > cur.weight || (items[b - 1].weight == cur.weight && items[b - 1].index > cur.index)))))
			{
				items[b] = items[b - 1];
				b--;
			}
			items[b] = cur;
		}
		for (size_t k = 0; k < items.size() / 2; k++)
		{
			Tok& t = tokens[items[k].index];
			t.ps = m_port.ApplyStress(t.ps, Stress(-0.5));
		}
	}

	Port m_port;
	OovChain* m_oov;
	int m_oovCount = 0;
};
} // namespace h9k
