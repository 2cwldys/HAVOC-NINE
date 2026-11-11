// ---- h9kokoro64: from text to audio ---------------------------------------------------------------------------------------
// Owns everything a line needs: the catalogue (voices.txt) and the chain constants (chains.txt: the trim), the voice files, the pronunciation data, and
// ONNX Runtime with the Kokoro model. PlanLine turns a text into the phrases it will be said in; SynthPhrase makes the audio of one phrase.
//
// What a phrase is: the phonemes between two pauses of the speech. A line short enough is one phrase. A longer one is cut where the speech pauses (after a
// comma, a full stop, a dash) and, when it has no pause, between words, so that the first phrase can be heard while the rest is made. Every call of the
// model costs about 0.8 s of audio in near-silence before and after the words (the model's own), so a phrase is not made shorter than it must be. The first
// one is cut near firstTarget phonemes (about 1.6 s of speech: it starts to sound once it is made); the others near laterTarget, which is about as long as the
// model takes to make one, so that the next phrase is ready as the one before it ends and the speech does not stop. A pause of the speech (a comma, a full
// stop) is where a phrase ends when one is near enough; the pause is then a part of the phrase's audio.
#pragma once

#include <stdint.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <memory>
#include <string>
#include <vector>

#include "h9_tts_catalogue.h"
#include "h9_tts_pack.h"
#include "h9_tts_proto.h"
#include "g2p_text.h"
#include "oov.h"
#include "ort_host.h"
#include "voice_bank.h"

namespace h9k
{
struct PhrasePolicy
{
	int singleMax = 34;     // a line of at most this many phonemes is one phrase
	int firstTarget = 26;   // the first phrase of a longer line ends near here
	int firstMax = 38;      // and not beyond this, whatever pause is further on
	int laterTarget = 30;   // the later phrases end near here
	int minPhrase = 14;     // a phrase is not cut shorter than this, and none is left shorter than this after a cut
	int maxPhrase = 50;     // the later phrases are not longer than this
};

struct Phrase
{
	Ps ps;        // vocabulary ids, no pads
	int pauseMs;  // silence after the phrase when another follows
};

class Engine
{
public:
	Engine() : m_threads(0) {}

	// dataDir holds voices.txt, chains.txt, g2p\, voices\ and model\. dllPath is onnxruntime.dll. Loads everything; false with the reason in err.
	bool Init(const std::wstring& dataDir, const std::wstring& dllPath, int threads, bool spin, std::string* err)
	{
		m_dataDir = dataDir;
		std::string text;
		if (!ReadText(dataDir + L"\\voices.txt", text, 1 << 20))
			return Fail(err, "cannot read voices.txt");
		m_catalogueCrc = h9tts::Crc32(text.data(), text.size());
		std::string why;
		if (!h9fx::ParseCatalogue(text, m_cat, why))
			return Fail(err, ("voices.txt: " + why).c_str());
		if (!ReadText(dataDir + L"\\chains.txt", text, 1 << 20) || !h9fx::ParseChains(text, m_chains))
			return Fail(err, "cannot read chains.txt");
		m_trimDb = m_chains.Const("trim_db", -46.0);
		m_trimPad = m_chains.Const("trim_pad_ms", 50.0) / 1000.0;

		std::string tokens;
		if (!ReadText(dataDir + L"\\g2p\\tokens.txt", tokens, 1 << 20) || !m_vocab.Load(tokens, &why))
			return Fail(err, "cannot read g2p\\tokens.txt");
		if (!ReadBytes(dataDir + L"\\g2p\\en_us.h9lex", m_lexBytes) || !m_lex.Load(m_lexBytes.data(), m_lexBytes.size(), &why))
			return Fail(err, ("en_us.h9lex: " + why).c_str());
		m_g2p.reset(new G2P(m_lex, m_vocab, nullptr));
		m_oov.reset(new LtsOov(m_g2p->P()));
		// without the trees the chain still handles clitics and spells the words it cannot say
		if (ReadBytes(dataDir + L"\\g2p\\en_us.h9lt", m_ltBytes))
			m_oov->LoadTrees(m_ltBytes.data(), m_ltBytes.size(), &why);
		m_g2p->SetOov(m_oov.get());

		m_bank.SetFolder(dataDir + L"\\voices");
		if (!m_bank.Preload(m_cat, &why))
			return Fail(err, why.c_str());

		m_ort.SetSpin(spin);
		if (!m_ort.Load((dllPath).c_str(), &why))
			return Fail(err, why.c_str());
		m_modelPath = dataDir + L"\\model\\model_quantized.onnx";
		return SetThreads(threads, err);
	}

	// A new session with this many threads (the model is read again). False with the reason in err; the old session is gone either way.
	bool SetThreads(int threads, std::string* err)
	{
		std::string why;
		m_ort.Close();
		if (!m_ort.Open(m_modelPath.c_str(), threads, &why))
			return Fail(err, why.c_str());
		m_threads = threads;
		return true;
	}

	int Threads() const { return m_threads; }
	int LoadMs() const { return m_ort.LoadMs(); }
	uint32_t CatalogueCrc() const { return m_catalogueCrc; }
	const std::string& OrtVersion() const { return m_ort.Version(); }
	const h9fx::Catalogue& Cat() const { return m_cat; }
	const Vocab& V() const { return m_vocab; }
	G2P& Gp() { return *m_g2p; }

	// The variant of a kind and a 1-based index inside the kind's list, or null.
	const h9fx::Variant* VariantOf(int kind, int index) const
	{
		if (kind < 0 || kind >= h9fx::KIND_COUNT || index < 1 || index > (int)m_cat.byKind[kind].size())
			return nullptr;
		return &m_cat.byKind[kind][(size_t)index - 1];
	}

	// The phrases a text will be said in. False when nothing in it can be spoken.
	bool PlanLine(const std::string& text, bool stream, const PhrasePolicy& pol, std::vector<Phrase>& out, int* g2pUs)
	{
		out.clear();
		const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
		Ps ps = m_g2p->Phonemize(text);
		if (g2pUs)
			*g2pUs = (int)std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
		const char space = (char)m_vocab.Id(' ');
		size_t a = 0, b = ps.size();
		while (a < b && ps[a] == space)
			a++;
		while (b > a && ps[b - 1] == space)
			b--;
		ps = ps.substr(a, b - a);
		bool voiced = false;
		for (size_t i = 0; i < ps.size(); i++)
		{
			if (ps[i] != space && !IsPunct(ps[i]))
				voiced = true;
		}
		if (!voiced)
			return false;
		if (!stream || (int)ps.size() <= pol.singleMax)
		{
			if (ps.size() > 500)
				return CutHard(ps, out);
			Phrase p = { ps, 0 };
			out.push_back(p);
			return true;
		}
		size_t pos = 0;
		bool first = true;
		while (pos < ps.size())
		{
			const size_t left = ps.size() - pos;
			const int target = first ? pol.firstTarget : pol.laterTarget;
			// what is left of a line that has been cut is one phrase when another cut would leave a stub (the first cut is made whatever is left: the line is longer than singleMax)
			if (!first && (int)left <= target + pol.minPhrase)
			{
				Phrase p = { Trimmed(ps.substr(pos), space), 0 };
				if (!p.ps.empty())
					out.push_back(p);
				break;
			}
			const size_t cut = FindCut(ps, pos, (size_t)target, (size_t)pol.minPhrase, first ? (size_t)pol.firstMax : (size_t)pol.maxPhrase, space);
			Phrase p = { Trimmed(ps.substr(pos, cut - pos), space), PauseAfter(ps, cut) };
			if (!p.ps.empty())
				out.push_back(p);
			pos = cut;
			while (pos < ps.size() && ps[pos] == space)
				pos++;
			first = false;
		}
		return !out.empty();
	}

	// The audio of one phrase in a voice: samples at 24 kHz, trimmed, with pauseMs of silence after them. cancelled is a flag another thread may raise.
	bool SynthPhrase(const h9fx::Variant& v, const Phrase& phrase, std::vector<int16_t>& out, int* synthMs, std::string* err)
	{
		out.clear();
		const int n = (int)phrase.ps.size();
		if (n < 1 || n > 508)
			return Fail(err, "a phrase has 1 to 508 phonemes");
		float style[VoiceBank::kDim];
		if (!m_bank.Style(v, n, style, err))
			return false;
		std::vector<int64_t> ids((size_t)n + 2);
		ids[0] = 0;
		for (int i = 0; i < n; i++)
			ids[(size_t)i + 1] = (unsigned char)phrase.ps[(size_t)i];
		ids[(size_t)n + 1] = 0;
		std::vector<float> pcm;
		const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
		if (!m_ort.Run(ids.data(), ids.size(), style, (float)v.speed, pcm, err))
			return false;
		if (synthMs)
			*synthMs = (int)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
		h9fx::Vec x(pcm.size());
		for (size_t i = 0; i < pcm.size(); i++)
			x[i] = (double)pcm[i];
		x = h9fx::Trim(x, (double)h9tts::proto::kSampleRate, m_trimDb, m_trimPad);
		out.resize(x.size());
		for (size_t i = 0; i < x.size(); i++)
		{
			double s = x[i] * 32767.0;
			s = s > 32767.0 ? 32767.0 : (s < -32768.0 ? -32768.0 : s);
			out[i] = (int16_t)(s >= 0 ? s + 0.5 : s - 0.5);
		}
		if (phrase.pauseMs > 0)
			out.resize(out.size() + (size_t)phrase.pauseMs * h9tts::proto::kSampleRate / 1000, 0);
		return true;
	}

	void Cancel() { m_ort.Cancel(); }
	void ClearCancel() { m_ort.ClearCancel(); }

private:
	bool IsPunct(char id) const
	{
		const Syms& S = m_g2p->P().S();
		return S.Has(S.nonQuote, id) || id == S.lquote || id == S.rquote;
	}

	// Ids of phrase ends: the punctuation after which the speech pauses.
	bool IsBreak(char id) const
	{
		const Syms& S = m_g2p->P().S();
		return S.Has(S.nonQuote, id);
	}

	static Ps Trimmed(const Ps& s, char space)
	{
		size_t a = 0, b = s.size();
		while (a < b && s[a] == space)
			a++;
		while (b > a && s[b - 1] == space)
			b--;
		return s.substr(a, b - a);
	}

	// How long the speech rests after the break at cut: a comma a little, a full stop more, a plain split between words not at all.
	int PauseAfter(const Ps& ps, size_t cut) const
	{
		if (cut == 0)
			return 0;
		const char last = ps[cut - 1];
		if (last == (char)m_vocab.Id(',') || last == (char)m_vocab.Id(';'))
			return 90;
		if (last == (char)m_vocab.Id(':'))
			return 120;
		if (last == (char)m_vocab.Id('.') || last == (char)m_vocab.Id('!') || last == (char)m_vocab.Id('?'))
			return 200;
		if (IsBreak(last))
			return 150;
		return 0;
	}

	// Where to cut ps, which has no cut before pos: after a break between min and max phonemes from pos (the one nearest the target), else after a space.
	// Where the phrase that starts at pos ends: a pause of the speech nearest to target, else a space nearest to it, not before minLen and not after maxLen; and
	// never so late that fewer than minLen phonemes are left.
	size_t FindCut(const Ps& ps, size_t pos, size_t target, size_t minLen, size_t maxLen, char space) const
	{
		const size_t lo = pos + minLen, hi = std::min(ps.size() > minLen ? ps.size() - minLen : (size_t)0, pos + maxLen);
		size_t best = 0, bestDist = (size_t)-1;
		for (int pass = 0; pass < 2 && !best; pass++)
		{
			for (size_t i = lo; i <= hi && i <= ps.size(); i++)
			{
				const bool ok = pass == 0 ? (i > 0 && IsBreak(ps[i - 1])) : (i < ps.size() && ps[i] == space);
				if (!ok)
					continue;
				const size_t at = pos + target;
				const size_t dist = i > at ? i - at : at - i;
				if (dist < bestDist)
				{
					bestDist = dist;
					best = i;
				}
			}
		}
		return best ? best : hi;
	}

	// A line with no pause and no space for hundreds of phonemes (not a chat line): cut where it must be.
	bool CutHard(const Ps& ps, std::vector<Phrase>& out) const
	{
		for (size_t pos = 0; pos < ps.size(); pos += 400)
		{
			Phrase p = { ps.substr(pos, 400), 0 };
			out.push_back(p);
		}
		return !out.empty();
	}

	static bool ReadBytes(const std::wstring& path, std::vector<uint8_t>& out)
	{
		FILE* f = _wfopen(path.c_str(), L"rb");
		if (!f)
			return false;
		out.clear();
		uint8_t buf[65536];
		size_t n;
		while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
			out.insert(out.end(), buf, buf + n);
		fclose(f);
		return !out.empty();
	}

	static bool ReadText(const std::wstring& path, std::string& out, size_t maxBytes)
	{
		std::vector<uint8_t> b;
		if (!ReadBytes(path, b) || b.size() > maxBytes)
			return false;
		out.assign((const char*)b.data(), b.size());
		return true;
	}

	static bool Fail(std::string* err, const char* why)
	{
		if (err)
			*err = why;
		return false;
	}

	std::wstring m_dataDir, m_modelPath;
	h9fx::Catalogue m_cat;
	h9fx::ChainSet m_chains;
	double m_trimDb = -46.0, m_trimPad = 0.05;
	uint32_t m_catalogueCrc = 0;
	Vocab m_vocab;
	std::vector<uint8_t> m_lexBytes, m_ltBytes;
	Lexicon m_lex;
	std::unique_ptr<G2P> m_g2p;
	std::unique_ptr<LtsOov> m_oov;
	VoiceBank m_bank;
	OrtHost m_ort;
	int m_threads;
};
} // namespace h9k
