// ---- H9 text to speech: the chain file --------------------------------------------------------------------------------
// Reads h9tts\chains.txt and runs a line through one named chain in the game's order: one resample (chain ratio * depth
// step ^ depth), normalise, chain stages, normalise. Header-only, standard library only.
//
// chains.txt lines (// starts a comment):
//     const <name> <number>
//     chain <id> [resample=<ratio>] <stage> <stage> ...      (stage syntax: see h9_fx.h)
#pragma once

#include <stdio.h>
#include <stdlib.h>

#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "h9_tts_fx.h"

namespace h9fx
{
struct ChainDef
{
	double resample;
	std::string stages;
};

struct ChainSet
{
	std::map<std::string, double> c;
	std::map<std::string, ChainDef> chain;
	double Const(const char* name, double fallback) const
	{
		std::map<std::string, double>::const_iterator it = c.find(name);
		return it == c.end() ? fallback : it->second;
	}
};

// Parses the text of chains.txt. False when it holds no chain.
inline bool ParseChains(const std::string& text, ChainSet& out)
{
	std::istringstream in(text);
	std::string line;
	while (std::getline(in, line))
	{
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
		if (t[0] == "const" && t.size() >= 3)
			out.c[t[1]] = atof(t[2].c_str());
		else if (t[0] == "chain" && t.size() >= 2)
		{
			ChainDef d;
			d.resample = 1.0;
			for (size_t i = 2; i < t.size(); i++)
			{
				if (t[i].compare(0, 9, "resample=") == 0)
					d.resample = atof(t[i].c_str() + 9);
				else
					d.stages += (d.stages.empty() ? "" : " ") + t[i];
			}
			out.chain[t[1]] = d;
		}
	}
	return !out.chain.empty();
}

inline bool LoadChains(const char* path, ChainSet& out)
{
	FILE* f = fopen(path, "rb");
	if (!f)
		return false;
	std::string text;
	char buf[4096];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		text.append(buf, n);
	fclose(f);
	return ParseChains(text, out);
}

// x: the trimmed Kokoro line (24 kHz). id: a chain id, or "-" for none. s: the muffle strength (1 for a machine). depth: total steps.
inline void RenderFx(Vec& x, const ChainSet& cs, const std::string& id, double s, int depth, bool applyStages = true)
{
	const double sr = cs.Const("sample_rate", 24000.0);
	double ratio = 1.0;
	std::string stages;
	std::map<std::string, ChainDef>::const_iterator it = cs.chain.find(id);
	if (it != cs.chain.end())
	{
		ratio = it->second.resample;
		if (applyStages)
			stages = it->second.stages;
	}
	if (depth > 12)
		depth = 12;
	if (depth < -12)
		depth = -12;
	ratio *= pow(cs.Const("depth_step", 1.025), (double)depth);
	if (ratio != 1.0)
		Resample(x, ratio);
	Normalize(x, sr, cs.Const("target_db", kTargetDb));
	RunChain(x, stages, s, sr);
	Normalize(x, sr, cs.Const("target_db", kTargetDb));
}
} // namespace h9fx
