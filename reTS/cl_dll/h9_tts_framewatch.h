// ---- H9 text to speech: watching the game's frame time while the helper works -----------------------------------------------
// The Kokoro helper takes some of the machine's processors for a second or two when a line is made. If the game's own frames get longer
// meanwhile, the helper is working with too many threads for this machine, and the client asks for fewer.
//
// The game calls Frame(dt, speaking) once a frame with the length of the frame; speaking says whether a line is being made by the helper
// right now. The frame time while nobody speaks is the baseline (an average that follows slow changes). A line made in at least kMinSpeakingFrames
// frames whose average is more than kSlowPercent above the baseline is a slow line; when kSlowLines of the last kHistory lines were slow the
// answer is "fewer": Frame returns true once and the history starts again. A frame over kMaxFrame seconds (a map change, a stall) counts for nothing.
// No engine or platform code: a test program feeds it frame times.
#pragma once

namespace h9tts
{
class FrameWatch
{
public:
	static const int kMinSpeakingFrames = 12;  // a line shorter than this many frames says nothing
	static const int kMinBaselineFrames = 120; // and so does a baseline of fewer
	static const int kHistory = 5;
	static const int kSlowLines = 3;
	static const int kSlowPercent = 10;
	static constexpr double kMaxFrame = 0.25;

	FrameWatch() { Reset(); }

	void Reset()
	{
		m_baseline = 0.0;
		m_baselineFrames = 0;
		m_busySum = 0.0;
		m_busyFrames = 0;
		m_wasSpeaking = false;
		for (int i = 0; i < kHistory; i++)
			m_slow[i] = 0;
		m_next = 0;
		m_lines = 0;
		m_lastRatio = 0.0;
		m_decisions = 0;
	}

	// True when the helper should use fewer threads from now on.
	bool Frame(double dt, bool speaking)
	{
		if (dt <= 0.0 || dt > kMaxFrame)
			return false;
		bool fewer = false;
		if (speaking)
		{
			m_busySum += dt;
			m_busyFrames++;
		}
		else
		{
			if (m_wasSpeaking)
				fewer = EndLine();
			m_baseline = m_baselineFrames == 0 ? dt : m_baseline * 0.98 + dt * 0.02;
			if (m_baselineFrames < 1000000)
				m_baselineFrames++;
		}
		m_wasSpeaking = speaking;
		return fewer;
	}

	// The last line's frame time against the baseline, as a ratio (1.0: no change), 0 before there was one.
	double LastRatio() const { return m_lastRatio; }
	double BaselineMs() const { return m_baseline * 1000.0; }
	int Lines() const { return m_lines; }
	int Decisions() const { return m_decisions; }
	int SlowInHistory() const
	{
		int n = 0;
		for (int i = 0; i < kHistory; i++)
			n += m_slow[i];
		return n;
	}

private:
	bool EndLine()
	{
		const int frames = m_busyFrames;
		const double mean = frames > 0 ? m_busySum / frames : 0.0;
		m_busySum = 0.0;
		m_busyFrames = 0;
		if (frames < kMinSpeakingFrames || m_baselineFrames < kMinBaselineFrames || m_baseline <= 0.0)
			return false;
		m_lastRatio = mean / m_baseline;
		m_slow[m_next] = m_lastRatio > 1.0 + kSlowPercent / 100.0 ? 1 : 0;
		m_next = (m_next + 1) % kHistory;
		m_lines++;
		if (m_lines >= kSlowLines && SlowInHistory() >= kSlowLines)
		{
			for (int i = 0; i < kHistory; i++)
				m_slow[i] = 0;
			m_decisions++;
			return true;
		}
		return false;
	}

	double m_baseline;
	int m_baselineFrames;
	double m_busySum;
	int m_busyFrames;
	bool m_wasSpeaking;
	int m_slow[kHistory];
	int m_next;
	int m_lines;
	double m_lastRatio;
	int m_decisions;
};
} // namespace h9tts
