// ---- H9 text to speech: the effect chains (24 kHz mono, doubles) ---------------------------------------------------
// What a Kokoro line goes through after it is synthesised: the trim of the near-silence around it, one resample (the
// speaker's depth and the kind's own pitch and tempo), the level, and the stages of a chain (a gas mask, a Mech, a bot,
// a droid). Nothing but <math.h> and the standard containers: RBJ biquads, a delay line, a tanh waveshaper,
// sample-and-hold, xorshift32 noise, cubic Hermite resampling, a gated RMS and a soft limiter. Platform neutral: the
// client library uses it for pre-rendered, cached and synthesised lines alike, and the helper process shares the trim.
// docs\TEXT_TO_SPEECH.txt (the Kokoro section) is the guide; h9tts\chains.txt is the data this runs.
//
// A chain is text, one stage per word: name=p0,p1,... where a number may be written A/s (A / (1 + s)) or A*s (A * s).
#pragma once

#include <math.h>
#include <stdint.h>

#include <string>
#include <vector>

namespace h9fx
{
typedef std::vector<double> Vec;

static const double kPi = 3.14159265358979323846;
static const double kTargetDb = -18.0; // the loudness every line is brought to (gated RMS, dBFS)
static const double kKnee = 0.80;      // soft limiter knee

// ---- biquads (RBJ cookbook), direct form II transposed, a0 normalised to 1 -------------------------------------------

struct Biquad
{
	double b0, b1, b2, a1, a2;
	double z1, z2;
	double Run(double x)
	{
		const double y = b0 * x + z1;
		z1 = b1 * x - a1 * y + z2;
		z2 = b2 * x - a2 * y;
		return y;
	}
};

inline Biquad Norm(double b0, double b1, double b2, double a0, double a1, double a2)
{
	Biquad f;
	f.b0 = b0 / a0;
	f.b1 = b1 / a0;
	f.b2 = b2 / a0;
	f.a1 = a1 / a0;
	f.a2 = a2 / a0;
	f.z1 = f.z2 = 0.0;
	return f;
}

// kind: "lowpass", "highpass", "bandpass" (constant 0 dB peak gain), "peak", "lowshelf", "highshelf" (slope S = 1)
inline Biquad Design(const std::string& kind, double f, double q, double db, double sr)
{
	if (f < 10.0)
		f = 10.0;
	if (f > 0.45 * sr)
		f = 0.45 * sr;
	const double w0 = 2.0 * kPi * f / sr;
	const double c = cos(w0), sn = sin(w0);
	if (kind == "lowpass")
	{
		const double al = sn / (2.0 * q);
		return Norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
	}
	if (kind == "highpass")
	{
		const double al = sn / (2.0 * q);
		return Norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
	}
	if (kind == "bandpass")
	{
		const double al = sn / (2.0 * q);
		return Norm(al, 0.0, -al, 1 + al, -2 * c, 1 - al);
	}
	if (kind == "peak")
	{
		const double a = pow(10.0, db / 40.0);
		const double al = sn / (2.0 * q);
		return Norm(1 + al * a, -2 * c, 1 - al * a, 1 + al / a, -2 * c, 1 - al / a);
	}
	const double a = pow(10.0, db / 40.0);
	const double al = sn / 2.0 * sqrt(2.0);
	const double sa = 2.0 * sqrt(a) * al;
	if (kind == "lowshelf")
		return Norm(a * ((a + 1) - (a - 1) * c + sa), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - sa),
			(a + 1) + (a - 1) * c + sa, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - sa);
	return Norm(a * ((a + 1) + (a - 1) * c + sa), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sa),
		(a + 1) - (a - 1) * c + sa, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sa);
}

inline void RunBiquad(Vec& x, Biquad f)
{
	for (size_t i = 0; i < x.size(); i++)
		x[i] = f.Run(x[i]);
}

// ---- trimming the near-silence Kokoro puts around a line -------------------------------------------------------------

// Envelope = RMS of 10 ms frames (hop 5 ms). The line starts at the first frame above peak_env * 10^(thrDb/20) and ends at the last
// one; padS seconds are kept on each side and a 10 ms raised-cosine fade closes both ends.
inline Vec Trim(const Vec& x, double sr, double thrDb, double padS)
{
	const int win = (int)(0.010 * sr), hop = (int)(0.005 * sr);
	const int n = ((int)x.size() - win) / hop + 1;
	if (n <= 0 || (int)x.size() < win)
		return x;
	Vec env((size_t)n);
	double mx = 0;
	for (int k = 0; k < n; k++)
	{
		double s = 0;
		for (int i = 0; i < win; i++)
			s += x[(size_t)(k * hop + i)] * x[(size_t)(k * hop + i)];
		env[(size_t)k] = sqrt(s / win);
		if (env[(size_t)k] > mx)
			mx = env[(size_t)k];
	}
	const double thr = mx * pow(10.0, thrDb / 20.0);
	int first = -1, last = -1;
	for (int k = 0; k < n; k++)
		if (env[(size_t)k] >= thr)
		{
			if (first < 0)
				first = k;
			last = k;
		}
	if (first < 0)
		return x;
	const long pad = (long)(padS * sr);
	long a = (long)first * hop - pad;
	if (a < 0)
		a = 0;
	long b = (long)last * hop + win + pad;
	if (b > (long)x.size())
		b = (long)x.size();
	Vec y(x.begin() + a, x.begin() + b);
	long f = (long)(0.010 * sr);
	if (f > (long)y.size() / 2)
		f = (long)y.size() / 2;
	if (f > 1)
		for (long i = 0; i < f; i++)
		{
			const double r = 0.5 - 0.5 * cos(kPi * (double)i / (double)f);
			y[(size_t)i] *= r;
			y[y.size() - 1 - (size_t)i] *= r;
		}
	return y;
}

// ---- level ------------------------------------------------------------------------------------------------------------

// Gated RMS: 20 ms frames (hop 10 ms), the mean energy of the frames within 20 dB of the loudest one, square-rooted.
inline double GatedRms(const Vec& x, double sr)
{
	const int win = (int)(0.020 * sr), hop = (int)(0.010 * sr);
	const int n = ((int)x.size() - win) / hop + 1;
	std::vector<double> e;
	if (n <= 0 || (int)x.size() < win)
	{
		double s = 0;
		for (size_t i = 0; i < x.size(); i++)
			s += x[i] * x[i];
		e.push_back(s / (x.empty() ? 1 : x.size()) + 1e-20);
	}
	else
	{
		for (int k = 0; k < n; k++)
		{
			double s = 0;
			for (int i = 0; i < win; i++)
				s += x[(size_t)(k * hop + i)] * x[(size_t)(k * hop + i)];
			e.push_back(s / win + 1e-20);
		}
	}
	double mx = 0;
	for (size_t k = 0; k < e.size(); k++)
		if (e[k] > mx)
			mx = e[k];
	const double thr = mx * pow(10.0, -20.0 / 10.0);
	double sum = 0;
	int cnt = 0;
	for (size_t k = 0; k < e.size(); k++)
		if (e[k] >= thr)
		{
			sum += e[k];
			cnt++;
		}
	return sqrt(sum / cnt);
}

inline double SoftLimit(double v)
{
	const double a = fabs(v);
	if (a <= kKnee)
		return v;
	const double y = kKnee + (1.0 - kKnee) * tanh((a - kKnee) / (1.0 - kKnee));
	return v < 0 ? -y : y;
}

// Brings the line to the target gated RMS and soft-limits it. Returns the fraction of samples the limiter touched.
inline double Normalize(Vec& x, double sr, double targetDb = kTargetDb)
{
	const double rms = GatedRms(x, sr);
	const double g = pow(10.0, targetDb / 20.0) / (rms > 1e-9 ? rms : 1e-9);
	size_t touched = 0;
	for (size_t i = 0; i < x.size(); i++)
	{
		x[i] *= g;
		if (fabs(x[i]) > kKnee)
			touched++;
		x[i] = SoftLimit(x[i]);
	}
	return x.empty() ? 0.0 : (double)touched / (double)x.size();
}

// ---- resampling: play the line `speed` times as fast (cubic Hermite / Catmull-Rom) -----------------------------------

inline void Resample(Vec& x, double speed)
{
	const int n = (int)((double)x.size() / speed);
	if (n < 2)
		return;
	const int last = (int)x.size() - 1;
	Vec out((size_t)n);
	for (int i = 0; i < n; i++)
	{
		const double pos = (double)i * speed;
		const int i1 = (int)floor(pos);
		const double t = pos - (double)i1;
		int ix[4] = { i1 - 1, i1, i1 + 1, i1 + 2 };
		double p[4];
		for (int k = 0; k < 4; k++)
		{
			const int j = ix[k] < 0 ? 0 : (ix[k] > last ? last : ix[k]);
			p[k] = x[(size_t)j];
		}
		out[(size_t)i] = p[1] + 0.5 * t * (p[2] - p[0] + t * (2 * p[0] - 5 * p[1] + 4 * p[2] - p[3] + t * (3 * (p[1] - p[2]) + p[3] - p[0])));
	}
	x.swap(out);
}

// ---- noise ----------------------------------------------------------------------------------------------------------

inline Vec Xorshift(size_t n, uint32_t seed = 2463534242u)
{
	Vec out(n);
	uint32_t st = seed;
	for (size_t i = 0; i < n; i++)
	{
		st ^= st << 13;
		st ^= st >> 17;
		st ^= st << 5;
		out[i] = (double)st / 2147483648.0 - 1.0;
	}
	return out;
}

inline void UnitRms(Vec& x)
{
	double s = 0;
	for (size_t i = 0; i < x.size(); i++)
		s += x[i] * x[i];
	const double r = sqrt(s / (double)x.size());
	const double d = r > 1e-12 ? r : 1e-12;
	for (size_t i = 0; i < x.size(); i++)
		x[i] /= d;
}

// The line's envelope, peak 1: |x| through a one-pole low-pass (time constant 20 ms), divided by its maximum.
inline Vec EnvFollow(const Vec& x, double sr)
{
	const double a = exp(-1.0 / (0.020 * sr));
	Vec e(x.size());
	double z = 0;
	double mx = 0;
	for (size_t i = 0; i < x.size(); i++)
	{
		z = (1 - a) * fabs(x[i]) + a * z;
		e[i] = z;
		if (z > mx)
			mx = z;
	}
	const double d = mx > 1e-12 ? mx : 1e-12;
	for (size_t i = 0; i < e.size(); i++)
		e[i] /= d;
	return e;
}

// ---- the chain ------------------------------------------------------------------------------------------------------

struct Stage
{
	std::string name;
	std::vector<std::string> p;
};

inline std::vector<Stage> ParseChain(const std::string& text)
{
	std::vector<Stage> out;
	size_t i = 0;
	while (i < text.size())
	{
		while (i < text.size() && text[i] == ' ')
			i++;
		size_t j = i;
		while (j < text.size() && text[j] != ' ')
			j++;
		if (j > i)
		{
			const std::string word = text.substr(i, j - i);
			Stage st;
			const size_t eq = word.find('=');
			st.name = word.substr(0, eq);
			if (eq != std::string::npos)
			{
				size_t a = eq + 1;
				while (a <= word.size())
				{
					size_t b = word.find(',', a);
					if (b == std::string::npos)
						b = word.size();
					st.p.push_back(word.substr(a, b - a));
					a = b + 1;
				}
			}
			out.push_back(st);
		}
		i = j;
	}
	return out;
}

inline double Val(const std::string& tok, double s)
{
	const size_t n = tok.size();
	if (n > 2 && tok[n - 2] == '/' && tok[n - 1] == 's')
		return atof(tok.substr(0, n - 2).c_str()) / (1.0 + s);
	if (n > 2 && tok[n - 2] == '*' && tok[n - 1] == 's')
		return atof(tok.substr(0, n - 2).c_str()) * s;
	return atof(tok.c_str());
}

inline void Breath(Vec& x, double preMs, double postMs, double burstDb, double leakDb, double centerHz, double s, double sr)
{
	const size_t pre = (size_t)floor(preMs * sr / 1000.0 + 0.5), post = (size_t)floor(postMs * sr / 1000.0 + 0.5);
	const size_t n = pre + x.size() + post;
	Vec nz = Xorshift(n);
	RunBiquad(nz, Design("bandpass", centerHz, 0.7, 0, sr));
	RunBiquad(nz, Design("lowpass", 1800.0, 0.7071, 0, sr));
	UnitRms(nz);
	const double L = GatedRms(x, sr);
	const double burst = L * pow(10.0, burstDb / 20.0) * s;
	const double leak = L * pow(10.0, leakDb / 20.0) * s;
	Vec out(n);
	const double ramp = 0.010 * sr > 1.0 ? 0.010 * sr : 1.0;
	for (size_t i = 0; i < n; i++)
	{
		double env = 0;
		if (i < pre)
		{
			const double t = (double)i / (double)pre;
			env = sin(0.5 * kPi * t);
			env *= env;
		}
		else if (i >= pre + x.size())
		{
			const size_t k = i - (pre + x.size());
			const double t = (double)k / (double)post;
			const double r = (double)k / ramp < 1.0 ? (double)k / ramp : 1.0;
			env = pow(1.0 - t, 1.5) * r;
		}
		out[i] = nz[i] * (leak + burst * env);
	}
	for (size_t i = 0; i < x.size(); i++)
		out[pre + i] += x[i];
	x.swap(out);
}

inline void RunStage(Vec& x, const Stage& st, double s, double sr)
{
	std::vector<double> v;
	for (size_t i = 0; i < st.p.size(); i++)
		v.push_back(Val(st.p[i], s));
	const std::string& nm = st.name;
	if (nm == "lowpass" || nm == "highpass" || nm == "bandpass")
		RunBiquad(x, Design(nm, v[0], v[1], 0, sr));
	else if (nm == "peak")
		RunBiquad(x, Design(nm, v[0], v[1], v[2], sr));
	else if (nm == "lowshelf" || nm == "highshelf")
		RunBiquad(x, Design(nm, v[0], 0.7071, v[1], sr));
	else if (nm == "ringmod")
	{
		for (size_t i = 0; i < x.size(); i++)
			x[i] *= (1 - v[1]) + v[1] * sin(2 * kPi * v[0] * (double)i / sr);
	}
	else if (nm == "tremolo")
	{
		for (size_t i = 0; i < x.size(); i++)
			x[i] *= 1 - v[1] * (0.5 - 0.5 * sin(2 * kPi * v[0] * (double)i / sr));
	}
	else if (nm == "bitcrush")
	{
		const int bits = (int)nearbyint(v[0]);
		int hold = (int)nearbyint(v[1]);
		if (hold < 1)
			hold = 1;
		const double q = pow(2.0, bits - 1);
		Vec y(x.size());
		for (size_t i = 0; i < x.size(); i++)
			y[i] = nearbyint(x[(i / (size_t)hold) * (size_t)hold] * q) / q;
		x.swap(y);
	}
	else if (nm == "saturate")
	{
		const double d = tanh(v[0]);
		for (size_t i = 0; i < x.size(); i++)
			x[i] = tanh(v[0] * x[i]) / d;
	}
	else if (nm == "clip")
	{
		for (size_t i = 0; i < x.size(); i++)
			x[i] = x[i] > v[0] ? v[0] : (x[i] < -v[0] ? -v[0] : x[i]);
	}
	else if (nm == "comb")
	{
		int d = (int)nearbyint(v[0] * sr / 1000.0);
		if (d < 1)
			d = 1;
		for (size_t i = (size_t)d; i < x.size(); i++)
			x[i] += v[1] * x[i - (size_t)d];
	}
	else if (nm == "noise")
	{
		Vec nz = Xorshift(x.size());
		UnitRms(nz);
		const double amp = GatedRms(x, sr) * pow(10.0, v[0] / 20.0);
		const Vec env = EnvFollow(x, sr);
		for (size_t i = 0; i < x.size(); i++)
			x[i] += nz[i] * amp * ((1 - v[1]) + v[1] * env[i]);
	}
	else if (nm == "gain")
	{
		const double g = pow(10.0, v[0] / 20.0);
		for (size_t i = 0; i < x.size(); i++)
			x[i] *= g;
	}
	else if (nm == "breath")
		Breath(x, v[0], v[1], v[2], v[3], v[4], s, sr);
}

inline void RunChain(Vec& x, const std::string& chain, double s, double sr)
{
	const std::vector<Stage> st = ParseChain(chain);
	for (size_t i = 0; i < st.size(); i++)
		RunStage(x, st[i], s, sr);
}
} // namespace h9fx
