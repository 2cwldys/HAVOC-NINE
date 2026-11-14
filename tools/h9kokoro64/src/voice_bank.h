// ---- h9kokoro64: the Kokoro voice files --------------------------------------------------------------------------------
// A voice is a table of style vectors, voices\<name>.bin: 510 rows of 256 little-endian floats (522,240 bytes); the row a line uses is the number
// of its phoneme ids minus one. A catalogue variant is a blend of one or more voices: the weights are normalised to sum 1 and the style vector of
// a row is the weighted mean of that row of each voice (computed in doubles, as the reference does).
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <map>
#include <string>
#include <vector>

#include "h9_tts_catalogue.h"

namespace h9k
{
class VoiceBank
{
public:
	static const int kRows = 510;
	static const int kDim = 256;

	void SetFolder(const std::wstring& dir) { m_dir = dir; }

	// The style vector of a variant for a line of n phoneme ids (without the two pads), n from 1 to 510. False with the reason in err.
	bool Style(const h9fx::Variant& v, int n, float* out, std::string* err)
	{
		if (n < 1 || n > kRows)
			return Fail(err, "a line has 1 to 510 phoneme ids");
		const std::vector<double> w = v.Weights();
		double acc[kDim];
		for (int i = 0; i < kDim; i++)
			acc[i] = 0.0;
		for (size_t p = 0; p < v.blend.size(); p++)
		{
			const std::vector<float>* rows = Pack(v.blend[p].voice, err);
			if (!rows)
				return false;
			const float* row = rows->data() + (size_t)(n - 1) * kDim;
			for (int i = 0; i < kDim; i++)
				acc[i] += (double)row[i] * w[p];
		}
		for (int i = 0; i < kDim; i++)
			out[i] = (float)acc[i];
		return true;
	}

	// Loads every voice a catalogue names, so that the first line does not wait for the disk. False with the first failure in err.
	bool Preload(const h9fx::Catalogue& cat, std::string* err)
	{
		for (int k = 0; k < h9fx::KIND_COUNT; k++)
		{
			for (size_t i = 0; i < cat.byKind[k].size(); i++)
			{
				for (size_t p = 0; p < cat.byKind[k][i].blend.size(); p++)
				{
					if (!Pack(cat.byKind[k][i].blend[p].voice, err))
						return false;
				}
			}
		}
		return true;
	}

	size_t Loaded() const { return m_packs.size(); }

private:
	// The rows of a voice, read once. The name is checked: letters, digits and underscores only, so it cannot leave the folder.
	const std::vector<float>* Pack(const std::string& name, std::string* err)
	{
		std::map<std::string, std::vector<float> >::const_iterator it = m_packs.find(name);
		if (it != m_packs.end())
			return &it->second;
		if (name.empty() || name.size() > 40)
		{
			Fail(err, "bad voice name");
			return nullptr;
		}
		for (size_t i = 0; i < name.size(); i++)
		{
			const char c = name[i];
			if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
			{
				Fail(err, "bad voice name");
				return nullptr;
			}
		}
		const std::wstring path = m_dir + L"\\" + std::wstring(name.begin(), name.end()) + L".bin";
		FILE* f = _wfopen(path.c_str(), L"rb");
		if (!f)
		{
			Fail(err, ("cannot open the voice file " + name + ".bin").c_str());
			return nullptr;
		}
		std::vector<float> rows((size_t)kRows * kDim);
		const size_t got = fread(rows.data(), sizeof(float), rows.size(), f);
		fseek(f, 0, SEEK_END);
		const long size = ftell(f);
		fclose(f);
		if (got != rows.size() || size < (long)(rows.size() * sizeof(float)) || size % (long)(kDim * sizeof(float)) != 0)
		{
			Fail(err, ("the voice file " + name + ".bin has the wrong size").c_str());
			return nullptr;
		}
		for (size_t i = 0; i < rows.size(); i++)
		{
			if (!(rows[i] > -1000.0f && rows[i] < 1000.0f))
			{
				Fail(err, ("the voice file " + name + ".bin holds a value that is not a style").c_str());
				return nullptr;
			}
		}
		return &(m_packs[name] = rows);
	}

	static bool Fail(std::string* err, const char* why)
	{
		if (err)
			*err = why;
		return false;
	}

	std::wstring m_dir;
	std::map<std::string, std::vector<float> > m_packs;
};
} // namespace h9k
