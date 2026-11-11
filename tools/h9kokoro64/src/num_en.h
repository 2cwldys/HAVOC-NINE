// ---- h9kokoro64: English number words ---------------------------------------------------------------------------------------
// The words misaki looks up after naming a number (the num2words rules for cardinals, ordinals, years and decimals), written out here with no 'and'
// and no commas: 1999 is "nineteen ninety nine", 105 is "one hundred five". Numbers of 10^15 and more are read digit by digit by the caller.
#pragma once

#include <stdint.h>

#include <string>
#include <vector>

namespace h9k
{
namespace numen
{
typedef std::vector<std::string> Words;

static const uint64_t kMaxCardinal = 1000000000000000ULL; // exclusive

inline const char* Ones(int i)
{
	static const char* ones[20] = { "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen",
		"fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen" };
	return ones[i];
}

inline void Below1000(int n, Words& out)
{
	static const char* tens[10] = { "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety" };
	const int h = n / 100, r = n % 100;
	if (h)
	{
		out.push_back(Ones(h));
		out.push_back("hundred");
	}
	if (r)
	{
		if (r < 20)
			out.push_back(Ones(r));
		else
		{
			out.push_back(tens[r / 10]);
			if (r % 10)
				out.push_back(Ones(r % 10));
		}
	}
}

inline Words Cardinal(uint64_t n)
{
	static const char* scales[5] = { "", "thousand", "million", "billion", "trillion" };
	Words out;
	if (n == 0)
	{
		out.push_back("zero");
		return out;
	}
	int groups[5];
	int count = 0;
	while (n && count < 5)
	{
		groups[count++] = (int)(n % 1000);
		n /= 1000;
	}
	for (int i = count - 1; i >= 0; i--)
	{
		if (groups[i])
		{
			Below1000(groups[i], out);
			if (scales[i][0])
				out.push_back(scales[i]);
		}
	}
	return out;
}

inline std::string OrdinalWord(const std::string& w)
{
	if (w == "one")
		return "first";
	if (w == "two")
		return "second";
	if (w == "three")
		return "third";
	if (w == "five")
		return "fifth";
	if (w == "eight")
		return "eighth";
	if (w == "nine")
		return "ninth";
	if (w == "twelve")
		return "twelfth";
	if (!w.empty() && w[w.size() - 1] == 'y')
		return w.substr(0, w.size() - 1) + "ieth";
	return w + "th";
}

inline Words Ordinal(uint64_t n)
{
	Words w = Cardinal(n);
	w[w.size() - 1] = OrdinalWord(w[w.size() - 1]);
	return w;
}

// 0 <= n <= 9999 read the way years are: 1999 nineteen ninety nine, 1905 nineteen oh five, 2000 two thousand.
inline Words Year(int n)
{
	const int high = n / 100, low = n % 100;
	if (high == 0 || (high % 10 == 0 && low < 10) || high >= 100)
		return Cardinal((uint64_t)n);
	Words out = Cardinal((uint64_t)high);
	if (low == 0)
		out.push_back("hundred");
	else if (low < 10)
	{
		out.push_back("oh");
		out.push_back(Ones(low));
	}
	else
	{
		const Words l = Cardinal((uint64_t)low);
		out.insert(out.end(), l.begin(), l.end());
	}
	return out;
}

inline Words DigitWords(const std::string& digits)
{
	Words out;
	for (size_t i = 0; i < digits.size(); i++)
	{
		if (digits[i] >= '0' && digits[i] <= '9')
			out.push_back(Ones(digits[i] - '0'));
	}
	return out;
}

// "3", "14" -> three point one four. Trailing zeros of the fraction are dropped; an all-zero fraction is not read at all.
inline Words DecimalWords(const std::string& intPart, const std::string& frac)
{
	size_t end = frac.size();
	while (end > 0 && frac[end - 1] == '0')
		end--;
	uint64_t ip = 0;
	for (size_t i = 0; i < intPart.size(); i++)
		ip = ip * 10 + (uint64_t)(intPart[i] - '0');
	Words out = Cardinal(ip);
	if (end == 0)
		return out;
	out.push_back("point");
	const Words d = DigitWords(frac.substr(0, end));
	out.insert(out.end(), d.begin(), d.end());
	return out;
}
} // namespace numen
} // namespace h9k
