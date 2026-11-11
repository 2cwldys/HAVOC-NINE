// ---- H9 text to speech: SHA-256 ---------------------------------------------------------------------------------------------
// The checksum the client takes of the Kokoro helper's program files and compares with h9tts\manifest.txt before it starts the helper. FIPS 180-4,
// written out here so that client.dll needs no cryptography library. Header-only, the C library only.
#pragma once

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <string>

namespace h9tts
{
class Sha256
{
public:
	Sha256() { Reset(); }

	void Reset()
	{
		static const uint32_t init[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
		memcpy(m_h, init, sizeof(m_h));
		m_len = 0;
		m_fill = 0;
	}

	void Update(const void* data, size_t n)
	{
		const uint8_t* p = (const uint8_t*)data;
		m_len += n;
		while (n > 0)
		{
			const size_t take = (64 - m_fill) < n ? (64 - m_fill) : n;
			memcpy(m_buf + m_fill, p, take);
			m_fill += take;
			p += take;
			n -= take;
			if (m_fill == 64)
			{
				Block(m_buf);
				m_fill = 0;
			}
		}
	}

	// The digest as 64 lower-case hex characters.
	std::string Final()
	{
		const uint64_t bits = (uint64_t)m_len * 8;
		const uint8_t one = 0x80;
		Update(&one, 1);
		const uint8_t zero = 0;
		while (m_fill != 56)
			Update(&zero, 1);
		uint8_t lenBytes[8];
		for (int i = 0; i < 8; i++)
			lenBytes[i] = (uint8_t)(bits >> (56 - 8 * i));
		Update(lenBytes, 8);
		static const char* hex = "0123456789abcdef";
		std::string out;
		for (int i = 0; i < 8; i++)
		{
			for (int k = 3; k >= 0; k--)
			{
				const uint8_t b = (uint8_t)(m_h[i] >> (8 * k));
				out += hex[b >> 4];
				out += hex[b & 15];
			}
		}
		return out;
	}

	// The checksum of a file (hex), empty when the file cannot be read.
	static std::string OfFile(FILE* f)
	{
		if (!f)
			return std::string();
		Sha256 s;
		uint8_t buf[65536];
		size_t n;
		while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
			s.Update(buf, n);
		return s.Final();
	}

private:
	static uint32_t Rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

	void Block(const uint8_t* b)
	{
		static const uint32_t k[64] = { 0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
			0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354,
			0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
			0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
			0xc67178f2 };
		uint32_t w[64];
		for (int i = 0; i < 16; i++)
			w[i] = ((uint32_t)b[4 * i] << 24) | ((uint32_t)b[4 * i + 1] << 16) | ((uint32_t)b[4 * i + 2] << 8) | (uint32_t)b[4 * i + 3];
		for (int i = 16; i < 64; i++)
		{
			const uint32_t s0 = Rotr(w[i - 15], 7) ^ Rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
			const uint32_t s1 = Rotr(w[i - 2], 17) ^ Rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		uint32_t a = m_h[0], bb = m_h[1], c = m_h[2], d = m_h[3], e = m_h[4], f = m_h[5], g = m_h[6], h = m_h[7];
		for (int i = 0; i < 64; i++)
		{
			const uint32_t s1 = Rotr(e, 6) ^ Rotr(e, 11) ^ Rotr(e, 25);
			const uint32_t ch = (e & f) ^ (~e & g);
			const uint32_t t1 = h + s1 + ch + k[i] + w[i];
			const uint32_t s0 = Rotr(a, 2) ^ Rotr(a, 13) ^ Rotr(a, 22);
			const uint32_t mj = (a & bb) ^ (a & c) ^ (bb & c);
			const uint32_t t2 = s0 + mj;
			h = g;
			g = f;
			f = e;
			e = d + t1;
			d = c;
			c = bb;
			bb = a;
			a = t1 + t2;
		}
		m_h[0] += a;
		m_h[1] += bb;
		m_h[2] += c;
		m_h[3] += d;
		m_h[4] += e;
		m_h[5] += f;
		m_h[6] += g;
		m_h[7] += h;
	}

	uint32_t m_h[8];
	uint64_t m_len;
	uint8_t m_buf[64];
	size_t m_fill;
};
} // namespace h9tts
