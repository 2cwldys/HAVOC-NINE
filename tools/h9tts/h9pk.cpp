// h9pk -- builds, lists, checks and unpacks the line packs of H9's text to speech (reTS/cl_dll/h9_tts_pack.h is the format).
//
//   h9pk build   <manifest.tsv> <out.h9pk>       the manifest is what prerender_lines.py writes: voice key TAB text TAB raw file (float32, 24 kHz)
//   h9pk list    <pack>                          every clip: key, samples, seconds, bytes
//   h9pk verify  <pack>                          the header, the index, the checksum, and every clip decodes
//   h9pk extract <pack> <voice key> <text> <out.f32>   the decoded clip, float32
//
// "build" decodes every clip it packed again and reports the signal-to-noise ratio of the ADPCM coding against the 16-bit source, so a
// pack made of clips that code badly is noticed when it is made.
//
// build: tools\h9tts\build_tools.bat

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include <string>
#include <vector>

#include "h9_tts_pack.h"

using namespace h9tts;

static bool ReadAll(const char* path, std::vector<uint8_t>& out)
{
	FILE* f = fopen(path, "rb");
	if (!f)
		return false;
	out.clear();
	uint8_t buf[65536];
	size_t n;
	while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
		out.insert(out.end(), buf, buf + n);
	fclose(f);
	return true;
}

static int Build(const char* manifest, const char* outPath)
{
	FILE* m = fopen(manifest, "rb");
	if (!m)
	{
		fprintf(stderr, "cannot open %s\n", manifest);
		return 2;
	}
	std::vector<PackClip> clips;
	std::vector<std::vector<int16_t> > sources;
	std::string line;
	int c;
	size_t skipped = 0;
	double sumSig = 0, sumErr = 0;
	size_t total = 0;
	for (;;)
	{
		line.clear();
		while ((c = fgetc(m)) != EOF && c != '\n')
			line += (char)c;
		if (line.empty() && c == EOF)
			break;
		if (!line.empty() && line.back() == '\r')
			line.pop_back();
		if (line.empty())
			continue;
		const size_t t1 = line.find('\t');
		const size_t t2 = t1 == std::string::npos ? t1 : line.find('\t', t1 + 1);
		if (t2 == std::string::npos)
		{
			fprintf(stderr, "bad manifest row: %s\n", line.c_str());
			fclose(m);
			return 2;
		}
		const std::string key = line.substr(0, t1);
		const std::string text = line.substr(t1 + 1, t2 - t1 - 1);
		const std::string path = line.substr(t2 + 1);
		std::vector<uint8_t> raw;
		if (!ReadAll(path.c_str(), raw) || raw.size() < 4 * 64 || raw.size() % 4)
		{
			skipped++;
			continue;
		}
		const size_t n = raw.size() / 4;
		if (n > kPackMaxSamples)
		{
			skipped++;
			continue;
		}
		std::vector<int16_t> pcm(n);
		for (size_t i = 0; i < n; i++)
		{
			float f;
			memcpy(&f, &raw[i * 4], 4);
			double v = (double)f * 32767.0;
			v = v > 32767.0 ? 32767.0 : (v < -32768.0 ? -32768.0 : v);
			pcm[i] = (int16_t)(v >= 0 ? v + 0.5 : v - 0.5);
		}
		PackClip pc;
		pc.key = PackKey(key, text.data(), text.size());
		pc.textCrc = Crc32(text.data(), text.size());
		pc.samples = (uint32_t)n;
		AdpcmEncode(pcm.data(), (int)n, pc.blob);
		std::vector<int16_t> back;
		if (!AdpcmDecode(pc.blob.data(), pc.blob.size(), pc.samples, back))
		{
			fprintf(stderr, "internal: a clip does not decode again: %s\n", text.c_str());
			fclose(m);
			return 3;
		}
		for (size_t i = 0; i < n; i++)
		{
			const double s = pcm[i], e = (double)back[i] - pcm[i];
			sumSig += s * s;
			sumErr += e * e;
		}
		total += n;
		clips.push_back(pc);
	}
	fclose(m);
	std::vector<uint8_t> file;
	if (!PackBuild(clips, file))
	{
		fprintf(stderr, "no clips\n");
		return 3;
	}
	FILE* o = fopen(outPath, "wb");
	if (!o || fwrite(file.data(), 1, file.size(), o) != file.size())
	{
		fprintf(stderr, "cannot write %s\n", outPath);
		if (o)
			fclose(o);
		return 2;
	}
	fclose(o);
	printf("%u clips, %.1f s of audio, %u bytes (%.1f KB per second), ADPCM SNR %.1f dB, %u rows skipped\n", (unsigned)clips.size(),
		(double)total / kPackRate, (unsigned)file.size(), file.size() / 1024.0 / ((double)total / kPackRate),
		10.0 * log10(sumSig / (sumErr > 0 ? sumErr : 1.0)), (unsigned)skipped);
	Pack p;
	std::string err;
	if (!p.Open(outPath, &err) || !p.Verify(outPath))
	{
		fprintf(stderr, "the pack just written does not verify: %s\n", err.c_str());
		return 3;
	}
	return 0;
}

static int List(const char* path)
{
	std::vector<uint8_t> all;
	if (!ReadAll(path, all) || all.size() < (size_t)kPackHeader)
		return 2;
	const uint32_t count = GetU32(&all[8]), indexOff = GetU32(&all[12]);
	printf("count %u  index at %u  file %u bytes\n", count, indexOff, (unsigned)all.size());
	for (uint32_t i = 0; i < count && (size_t)indexOff + (size_t)(i + 1) * kPackEntry <= all.size(); i++)
	{
		const uint8_t* e = &all[indexOff + (size_t)i * kPackEntry];
		printf("%016llx  %7u samples  %6.2f s  %6u bytes\n", (unsigned long long)GetU64(e), GetU32(e + 12), GetU32(e + 12) / (double)kPackRate, GetU32(e + 16));
	}
	return 0;
}

static int Verify(const char* path)
{
	Pack p;
	std::string err;
	if (!p.Open(path, &err))
	{
		printf("FAIL: %s\n", err.c_str());
		return 1;
	}
	if (!p.Verify(path))
	{
		printf("FAIL: the checksum does not match\n");
		return 1;
	}
	std::vector<uint8_t> all;
	ReadAll(path, all);
	const uint32_t count = GetU32(&all[8]), indexOff = GetU32(&all[12]);
	for (uint32_t i = 0; i < count; i++)
	{
		const uint8_t* e = &all[indexOff + (size_t)i * kPackEntry];
		std::vector<int16_t> pcm;
		if (!AdpcmDecode(&all[kPackHeader + GetU32(e + 8)], GetU32(e + 16), GetU32(e + 12), pcm))
		{
			printf("FAIL: clip %u does not decode\n", i);
			return 1;
		}
	}
	printf("ok: %u clips\n", count);
	return 0;
}

static int Extract(const char* path, const char* key, const char* text, const char* outPath)
{
	Pack p;
	std::string err;
	if (!p.Open(path, &err))
	{
		fprintf(stderr, "%s\n", err.c_str());
		return 1;
	}
	std::vector<int16_t> pcm;
	if (!p.Find(key, text, pcm))
	{
		fprintf(stderr, "not in the pack\n");
		return 1;
	}
	FILE* o = fopen(outPath, "wb");
	if (!o)
		return 2;
	for (size_t i = 0; i < pcm.size(); i++)
	{
		const float f = (float)pcm[i] / 32768.0f;
		fwrite(&f, 4, 1, o);
	}
	fclose(o);
	printf("%u samples\n", (unsigned)pcm.size());
	return 0;
}

int main(int argc, char** argv)
{
	if (argc >= 4 && !strcmp(argv[1], "build"))
		return Build(argv[2], argv[3]);
	if (argc >= 3 && !strcmp(argv[1], "list"))
		return List(argv[2]);
	if (argc >= 3 && !strcmp(argv[1], "verify"))
		return Verify(argv[2]);
	if (argc >= 6 && !strcmp(argv[1], "extract"))
		return Extract(argv[2], argv[3], argv[4], argv[5]);
	fprintf(stderr, "usage: h9pk build <manifest.tsv> <out.h9pk> | list <pack> | verify <pack> | extract <pack> <voice key> <text> <out.f32>\n");
	return 1;
}
