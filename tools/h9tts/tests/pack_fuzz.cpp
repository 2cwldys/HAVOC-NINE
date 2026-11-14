// pack_fuzz -- the line pack reader against damaged files (reTS/cl_dll/h9_tts_pack.h).
//
//   pack_fuzz <good pack> <iterations> [seed]
//
// Takes a good pack and damages it in many ways: single bytes, runs of bytes, the header fields, the index, a truncation, an extension, a
// swap of two index entries. Every damaged file must either be refused by Open or read without leaving its own bounds: when Open accepts it,
// every clip is decoded and a lookup is made. Built with the address sanitizer, a read past a buffer is a failure. Also checks the ADPCM
// decoder against short, long and empty input, and the writer's round trip.
//
// build: tools\h9tts\tests\build_tests.bat

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <string>
#include <vector>

#include "h9_tts_pack.h"

using namespace h9tts;

static uint32_t g_state = 12345;
static uint32_t Rnd()
{
	g_state ^= g_state << 13;
	g_state ^= g_state >> 17;
	g_state ^= g_state << 5;
	return g_state;
}

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

static int g_fail = 0;
#define CHECK(c, ...)                                                                                                                      \
	do                                                                                                                                     \
	{                                                                                                                                      \
		if (!(c))                                                                                                                          \
		{                                                                                                                                  \
			printf("FAIL line %d: ", __LINE__);                                                                                            \
			printf(__VA_ARGS__);                                                                                                           \
			printf("\n");                                                                                                                  \
			g_fail++;                                                                                                                      \
		}                                                                                                                                  \
	} while (0)

static void AdpcmTests()
{
	// the step table has 89 entries and ends at 32767
	CHECK(kAdpcmStep[0] == 7 && kAdpcmStep[88] == 32767, "step table ends");
	for (int i = 1; i < 89; i++)
		CHECK(kAdpcmStep[i] > kAdpcmStep[i - 1], "step table not increasing at %d", i);

	// round trip of a sine: the decoder follows the encoder's own state exactly
	std::vector<int16_t> sine(4801);
	for (size_t i = 0; i < sine.size(); i++)
		sine[i] = (int16_t)(12000.0 * sin(2.0 * 3.14159265358979 * 440.0 * (double)i / 24000.0));
	std::vector<uint8_t> blob;
	AdpcmEncode(sine.data(), (int)sine.size(), blob);
	CHECK(blob.size() == 4 + (sine.size()) / 2, "blob size %u for %u samples", (unsigned)blob.size(), (unsigned)sine.size());
	std::vector<int16_t> back;
	CHECK(AdpcmDecode(blob.data(), blob.size(), (uint32_t)sine.size(), back), "decode");
	double sig = 0, err = 0;
	for (size_t i = 0; i < sine.size(); i++)
	{
		sig += (double)sine[i] * sine[i];
		err += ((double)back[i] - sine[i]) * ((double)back[i] - sine[i]);
	}
	CHECK(10.0 * log10(sig / err) > 25.0, "sine SNR %.1f dB", 10.0 * log10(sig / err));

	// odd and even lengths, one and two samples
	for (int n = 1; n < 40; n++)
	{
		std::vector<int16_t> s(n), b;
		for (int i = 0; i < n; i++)
			s[i] = (int16_t)(1000 * i - 8000);
		AdpcmEncode(s.data(), n, blob);
		CHECK(blob.size() == (size_t)(4 + n / 2), "n=%d blob %u", n, (unsigned)blob.size());
		CHECK(AdpcmDecode(blob.data(), blob.size(), (uint32_t)n, b) && (int)b.size() == n && b[0] == s[0], "n=%d decode", n);
	}

	// refusals
	std::vector<int16_t> out;
	CHECK(!AdpcmDecode(blob.data(), blob.size(), 0, out), "zero samples");
	CHECK(!AdpcmDecode(blob.data(), 3, 10, out), "blob under 4 bytes");
	CHECK(!AdpcmDecode(blob.data(), blob.size(), 100000, out), "more samples than bytes");
	CHECK(!AdpcmDecode(blob.data(), blob.size(), kPackMaxSamples + 1, out), "over the sample limit");
	uint8_t junk[64];
	for (int i = 0; i < 64; i++)
		junk[i] = (uint8_t)Rnd();
	junk[2] = 200; // a step index out of range is clamped, not indexed
	CHECK(AdpcmDecode(junk, 64, 120, out), "junk with an index above 88");
}

static void WriteFile(const char* path, const std::vector<uint8_t>& v)
{
	FILE* f = fopen(path, "wb");
	if (f)
	{
		fwrite(v.data(), 1, v.size(), f);
		fclose(f);
	}
}

static void Exercise(const char* path, int& accepted)
{
	Pack p;
	std::string err;
	if (!p.Open(path, &err))
		return;
	accepted++;
	std::vector<int16_t> pcm;
	for (size_t i = 0; i < p.Count(); i++)
	{
		p.At(i, pcm);
		CHECK(pcm.size() <= kPackMaxSamples, "a clip of %u samples", (unsigned)pcm.size());
	}
	p.Find("am_michael@1.00", "hello", pcm);
	p.Close();
}

int main(int argc, char** argv)
{
	if (argc < 3)
	{
		fprintf(stderr, "usage: pack_fuzz <good pack> <iterations> [seed]\n");
		return 2;
	}
	if (argc > 3)
		g_state = (uint32_t)atoi(argv[3]) | 1u;
	AdpcmTests();

	std::vector<uint8_t> good;
	if (!ReadAll(argv[1], good) || good.size() < 100)
	{
		fprintf(stderr, "cannot read %s\n", argv[1]);
		return 2;
	}
	const int iterations = atoi(argv[2]);
	const char* tmp = "pack_fuzz.tmp";
	Pack ok;
	std::string err;
	CHECK(ok.Open(argv[1], &err), "the good pack opens: %s", err.c_str());
	ok.Close();
	const uint32_t indexOff = GetU32(&good[12]);
	int accepted = 0;
	for (int it = 0; it < iterations; it++)
	{
		std::vector<uint8_t> bad = good;
		switch (Rnd() % 8)
		{
		case 0: // a few random bytes anywhere
			for (int k = 0, n = 1 + (int)(Rnd() % 8); k < n; k++)
				bad[Rnd() % bad.size()] = (uint8_t)Rnd();
			break;
		case 1: // the header
			for (int k = 0, n = 1 + (int)(Rnd() % 4); k < n; k++)
				bad[Rnd() % kPackHeader] = (uint8_t)Rnd();
			break;
		case 2: // the index
			for (int k = 0, n = 1 + (int)(Rnd() % 12); k < n; k++)
				bad[indexOff + Rnd() % (bad.size() - indexOff)] = (uint8_t)Rnd();
			break;
		case 3: // truncated
			bad.resize(Rnd() % bad.size());
			break;
		case 4: // extended
			for (int k = 0, n = 1 + (int)(Rnd() % 64); k < n; k++)
				bad.push_back((uint8_t)Rnd());
			break;
		case 5: // two index entries swapped
		{
			const size_t count = (bad.size() - indexOff) / kPackEntry;
			if (count >= 2)
			{
				const size_t a = Rnd() % count, b = Rnd() % count;
				for (int k = 0; k < kPackEntry; k++)
				{
					const uint8_t t = bad[indexOff + a * kPackEntry + k];
					bad[indexOff + a * kPackEntry + k] = bad[indexOff + b * kPackEntry + k];
					bad[indexOff + b * kPackEntry + k] = t;
				}
			}
			break;
		}
		case 6: // an index field set to an extreme
		{
			const size_t count = (bad.size() - indexOff) / kPackEntry;
			const size_t e = indexOff + (Rnd() % count) * kPackEntry + 8 + 4 * (Rnd() % 3);
			const uint32_t v = (Rnd() & 1) ? 0xFFFFFFFFu : (Rnd() & 1 ? 0u : 0x7FFFFFFFu);
			for (int k = 0; k < 4; k++)
				bad[e + k] = (uint8_t)(v >> (8 * k));
			break;
		}
		default: // the data region
			for (int k = 0, n = 1 + (int)(Rnd() % 16); k < n; k++)
				bad[kPackHeader + Rnd() % (indexOff - kPackHeader)] = (uint8_t)Rnd();
			break;
		}
		WriteFile(tmp, bad);
		Exercise(tmp, accepted);
	}
	remove(tmp);

	// the writer: clips in, the same clips out; a duplicate key keeps the first
	std::vector<PackClip> clips;
	for (int i = 0; i < 5; i++)
	{
		std::vector<int16_t> s(2000 + 100 * i);
		for (size_t k = 0; k < s.size(); k++)
			s[k] = (int16_t)(5000.0 * sin(0.05 * (double)k * (i + 1)));
		PackClip c;
		const std::string text = "line " + std::string(1, (char)('a' + i));
		c.key = PackKey("voice@1.00", text.data(), text.size());
		c.textCrc = Crc32(text.data(), text.size());
		c.samples = (uint32_t)s.size();
		AdpcmEncode(s.data(), (int)s.size(), c.blob);
		clips.push_back(c);
	}
	clips.push_back(clips[2]);
	std::vector<uint8_t> file;
	CHECK(PackBuild(clips, file), "PackBuild");
	WriteFile(tmp, file);
	Pack p;
	CHECK(p.Open(tmp, &err), "the written pack opens: %s", err.c_str());
	CHECK(p.Count() == 5, "five clips, a duplicate dropped, got %u", (unsigned)p.Count());
	std::vector<int16_t> pcm;
	CHECK(p.Find("voice@1.00", "line c", pcm) && pcm.size() == 2200, "find line c");
	CHECK(!p.Find("voice@1.00", "line z", pcm), "line z is not there");
	CHECK(!p.Find("other@1.00", "line c", pcm), "another voice is not the same clip");
	CHECK(p.Verify(tmp), "verify");
	p.Close();
	remove(tmp);

	printf("pack_fuzz: %d iterations, %d damaged files were accepted by Open and read within bounds, %d failure(s)\n", iterations, accepted, g_fail);
	return g_fail ? 1 : 0;
}
