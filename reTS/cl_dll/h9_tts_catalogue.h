// ---- H9 text to speech: the voice catalogue ------------------------------------------------------------------------------
// Reads h9tts\voices.txt in plain C++: standard library only, no exceptions (the web build of the client library is
// compiled with -fno-exceptions). The helper process reads the same file, so a variant means the same voice in both.
//
// Lines (// starts a comment):
//     default <kind> <index>
//     variant <kind> <index> <name> <lang> <blend> <speed> <depth> <chain> <mask> [note ...]
// kind: man woman mech bot droid;  blend: voice[:weight][+voice[:weight]...];  chain and mask: a chain id of chains.txt or "-".
// A variant number N a player chose (cl_h9_tts_myvoice, 1 .. 99) selects index ((N - 1) mod count); N = 0 selects the kind's default.
#pragma once

#include <stdio.h>
#include <stdlib.h>

#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "h9_tts_chains.h"

namespace h9fx
{
enum Kind { KIND_MAN = 0, KIND_WOMAN, KIND_MECH, KIND_BOT, KIND_DROID, KIND_COUNT };

struct BlendPart
{
	std::string voice; // style file name without .bin
	double weight;     // as written
};

struct Variant
{
	int kind;
	int index; // 1 based inside its kind
	std::string name, lang;
	std::vector<BlendPart> blend;
	double speed; // Kokoro's speed input
	int depth;    // the variant's own depth steps
	std::string chain, mask, note;

	// weights normalised to sum 1 (the caller blends the style tables with them)
	std::vector<double> Weights() const
	{
		double sum = 0;
		for (size_t i = 0; i < blend.size(); i++)
			sum += blend[i].weight;
		std::vector<double> w(blend.size());
		for (size_t i = 0; i < blend.size(); i++)
			w[i] = sum > 0 ? blend[i].weight / sum : 0.0;
		return w;
	}
};

struct Catalogue
{
	std::vector<Variant> byKind[KIND_COUNT];
	int def[KIND_COUNT];
	Catalogue()
	{
		for (int k = 0; k < KIND_COUNT; k++)
			def[k] = 1;
	}
	// variant 0 = the kind's default; 1 .. 99 = ((variant - 1) mod count). nullptr when the kind has no variants.
	const Variant* Pick(int kind, int variant) const
	{
		if (kind < 0 || kind >= KIND_COUNT || byKind[kind].empty())
			return nullptr;
		const int n = (int)byKind[kind].size();
		int idx = variant < 1 ? def[kind] - 1 : (variant - 1) % n;
		if (idx < 0 || idx >= n)
			idx = 0;
		return &byKind[kind][(size_t)idx];
	}
};

inline int KindOf(const std::string& s)
{
	static const char* names[KIND_COUNT] = { "man", "woman", "mech", "bot", "droid" };
	for (int k = 0; k < KIND_COUNT; k++)
		if (s == names[k])
			return k;
	return -1;
}

// The key a pre-rendered or cached line is filed under: the blend with its weights normalised to two decimals, then the speed
// ("am_michael:0.30+am_fenrir:0.70@0.95"; a single voice is its name alone before the @). The depth, the chains and the lang
// are not in it: the stored line is the raw trimmed synthesis, and what the listener adds to it is done on playback.
inline std::string VoiceKey(const Variant& v)
{
	std::string out;
	double sum = 0;
	for (size_t i = 0; i < v.blend.size(); i++)
		sum += v.blend[i].weight;
	char buf[64];
	for (size_t i = 0; i < v.blend.size(); i++)
	{
		if (i)
			out += '+';
		out += v.blend[i].voice;
		if (v.blend.size() > 1)
		{
			snprintf(buf, sizeof(buf), ":%.2f", sum > 0 ? v.blend[i].weight / sum : 0.0);
			out += buf;
		}
	}
	snprintf(buf, sizeof(buf), "@%.2f", v.speed);
	return out + buf;
}

inline bool ParseBlend(const std::string& text, std::vector<BlendPart>& out)
{
	size_t i = 0;
	while (i <= text.size())
	{
		size_t j = text.find('+', i);
		if (j == std::string::npos)
			j = text.size();
		const std::string part = text.substr(i, j - i);
		if (part.empty())
			return false;
		BlendPart b;
		const size_t c = part.find(':');
		b.voice = part.substr(0, c);
		b.weight = c == std::string::npos ? 1.0 : atof(part.c_str() + c + 1);
		if (b.voice.empty())
			return false;
		out.push_back(b);
		i = j + 1;
	}
	return !out.empty();
}

inline bool ParseCatalogue(const std::string& text, Catalogue& cat, std::string& err)
{
	std::istringstream in(text);
	std::string line;
	int n = 0;
	char buf[160];
	while (std::getline(in, line))
	{
		n++;
		const size_t cm = line.find("//");
		if (cm != std::string::npos)
			line.erase(cm);
		std::istringstream ls(line);
		std::vector<std::string> t;
		std::string w;
		while (ls >> w)
			t.push_back(w);
		if (t.empty())
			continue;
		if (t[0] == "default" && t.size() == 3)
		{
			const int k = KindOf(t[1]);
			if (k < 0)
			{
				snprintf(buf, sizeof(buf), "line %d: unknown kind '%s'", n, t[1].c_str());
				err = buf;
				return false;
			}
			cat.def[k] = atoi(t[2].c_str());
		}
		else if (t[0] == "variant" && t.size() >= 10)
		{
			Variant v;
			v.kind = KindOf(t[1]);
			v.index = atoi(t[2].c_str());
			if (v.kind < 0 || v.index != (int)cat.byKind[v.kind < 0 ? 0 : v.kind].size() + 1)
			{
				snprintf(buf, sizeof(buf), "line %d: bad kind or index out of order", n);
				err = buf;
				return false;
			}
			v.name = t[3];
			v.lang = t[4];
			if (!ParseBlend(t[5], v.blend))
			{
				snprintf(buf, sizeof(buf), "line %d: bad blend '%s'", n, t[5].c_str());
				err = buf;
				return false;
			}
			v.speed = atof(t[6].c_str());
			v.depth = atoi(t[7].c_str());
			v.chain = t[8];
			v.mask = t[9];
			for (size_t i = 10; i < t.size(); i++)
				v.note += (v.note.empty() ? "" : " ") + t[i];
			double sum = 0;
			for (size_t i = 0; i < v.blend.size(); i++)
				sum += v.blend[i].weight;
			if (!(v.speed >= 0.5 && v.speed <= 2.0) || v.depth < -12 || v.depth > 12 || !(sum > 0) || (v.lang != "en-us" && v.lang != "en-gb"))
			{
				snprintf(buf, sizeof(buf), "line %d: speed, depth, weights or lang out of range", n);
				err = buf;
				return false;
			}
			cat.byKind[v.kind].push_back(v);
		}
		else
		{
			snprintf(buf, sizeof(buf), "line %d: unknown line '%s'", n, t[0].c_str());
			err = buf;
			return false;
		}
	}
	for (int k = 0; k < KIND_COUNT; k++)
		if (cat.byKind[k].empty() || cat.def[k] < 1 || cat.def[k] > (int)cat.byKind[k].size())
		{
			snprintf(buf, sizeof(buf), "kind %d has no variants or a default outside its list", k);
			err = buf;
			return false;
		}
	return true;
}

inline bool LoadCatalogue(const char* path, Catalogue& cat, std::string& err)
{
	FILE* f = fopen(path, "rb");
	if (!f)
	{
		err = "cannot open the catalogue";
		return false;
	}
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	return ParseCatalogue(text, cat, err);
}

// Every chain a variant names must exist in chains.txt (machine kinds: the chain; man and woman: the mask). Returns false with the first miss.
inline bool CheckChains(const Catalogue& cat, const ChainSet& cs, std::string& err)
{
	for (int k = 0; k < KIND_COUNT; k++)
		for (size_t i = 0; i < cat.byKind[k].size(); i++)
		{
			const Variant& v = cat.byKind[k][i];
			const std::string& id = k >= KIND_MECH ? v.chain : v.mask;
			if (id == "-" || cs.chain.find(id) == cs.chain.end())
			{
				err = "variant '" + v.name + "' names the chain '" + id + "' that chains.txt does not have";
				return false;
			}
		}
	return true;
}
} // namespace h9fx
