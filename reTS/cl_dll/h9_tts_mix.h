// ---- H9 text to speech: the voice mixer ------------------------------------------------------------------------
// The part of the client that decides which spoken lines are heard together, and sums them. It knows nothing of SAPI, the
// browser or the sound card: a platform renders a line to mono samples at kMixRate, hands them over with Submit, and calls Mix
// for every block of samples its output wants. docs\TEXT_TO_SPEECH.txt (section 5) is the guide.
//
//   voices    up to the listener's limit (cl_h9_tts_maxvoices, kMixMaxVoices at the most) play together, summed. A line that
//             arrives when they are all busy waits for a voice. A line that is playing is never cut off to make room.
//   waiting   at most kMixMaxWaiting lines wait, none longer than kMixMaxWaitMs after it arrived. A newer line of a speaker
//             replaces his older waiting one; when the list is full the quietest line goes (the oldest of equals), before it
//             was ever heard.
//   speaker   one speaker's lines do not overlap: a line of his that arrives while he is speaking waits for his voice to end.
//   output    the sum passes a soft limiter (exact below kMixKnee, never past full scale). A voice fades in and out over a few
//             milliseconds, and StopAll fades everything out over kMixStopFrames.
//   streams   a line that is made in pieces (the Kokoro voices) is submitted with its first piece, open, and given the rest through
//             Append. Its voice plays what has arrived and is silent when it has played all of it, without ending, until the last piece
//             has been appended and played (no fade-out is put on the end of what has arrived, only on the end of the line). Append
//             says false when the line is gone (replaced, stopped, dropped for waiting too long): the maker stops making it.
//
// A line is mono, 16 bit, at kMixRate; a renderer that makes another rate resamples before Submit. The mixer is not thread safe:
// the platform locks around every call. This header includes only the C library, so a test program builds it alone.
#pragma once

#include <math.h>
#include <stdlib.h>
#include <string.h>

#ifndef H9TTS_MIX_FREE
#define H9TTS_MIX_FREE(p) free(p) // a test program counts the lines the mixer lets go of
#endif
#ifndef H9TTS_MIX_ALLOC
#define H9TTS_MIX_ALLOC(n) malloc(n) // and the buffers it makes
#endif

namespace h9tts
{
const int kMixRate = 22050;      // samples a second, of the lines and of the output
const int kMixMaxVoices = 8;     // voices playing together, at the most
const int kMixMaxWaiting = 4;    // lines waiting for a voice, at the most
const int kMixMaxWaitMs = 8000;  // a line that has waited this long since it arrived is not spoken any more
const int kMixFadeFrames = 110;  // the ramp at the start and at the end of a line: 5 ms
const int kMixStopFrames = 660;  // the fade-out of a stop: 30 ms
const float kMixKnee = 26000.0f; // the limiter leaves a sum below this as it is

struct Clip
{
	int speaker;      // 1 to 255
	short* pcm;       // mono samples, malloc'd: the mixer frees them, whatever becomes of the line
	int frames;
	float gainL;      // multiplied into the samples for the left ear
	float gainR;      // and for the right ear
	float priority;   // how loud the line is meant to be heard (0 to 2): a full waiting list lets the quietest go
	int limit;        // the voices the listener allows at once (cl_h9_tts_maxvoices)
	unsigned arrived; // the clock, in milliseconds, when the line was received
	int stream;       // 0 for a line that is whole; above 0 for a line that is still being made: more samples follow through Append (open)
	bool open;        // a streamed line has more to come until Append says it is the last piece
};

class Mixer
{
public:
	// What became of a line handed to Submit.
	enum Result
	{
		kStarted, // it is playing
		kWaiting, // it waits for a voice (or for its speaker's voice to end)
		kDropped  // it is gone: nothing to say, or the waiting list is full of louder lines
	};

	Mixer()
	{
		memset(m_voice, 0, sizeof(m_voice));
		memset(m_wait, 0, sizeof(m_wait));
		m_nWait = 0;
	}

	~Mixer()
	{
		Clear();
	}

	// Takes the line over. now is the clock in milliseconds (wrap-safe: only differences are read).
	Result Submit(const Clip& clip, unsigned now)
	{
		if (!clip.pcm)
			return kDropped;
		if (clip.frames < 2 || clip.speaker < 1 || clip.speaker > 255)
		{
			H9TTS_MIX_FREE(clip.pcm);
			return kDropped;
		}
		Promote(now);
		RemoveWaiting(clip.speaker);
		if (!SpeakerPlaying(clip.speaker) && Playing() < ClampLimit(clip.limit))
		{
			Start(clip);
			return kStarted;
		}
		return Enqueue(clip) ? kWaiting : kDropped;
	}

	// Gives a streamed line (Submit with its stream number and open) its next piece: pcm (frames mono samples, malloc'd, taken over) is
	// put after what the line has. last says it is the final piece. False when the line is not there any more, which is the
	// maker's cue to stop making it; the samples are let go of then.
	bool Append(int speaker, int stream, short* pcm, int frames, bool last)
	{
		if (stream <= 0 || frames < 0 || (frames > 0 && !pcm))
		{
			H9TTS_MIX_FREE(pcm);
			return false;
		}
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			Voice& vo = m_voice[v];
			if (vo.active && !vo.stopping && vo.speaker == speaker && vo.stream == stream && vo.open)
			{
				if (!Extend(vo.pcm, vo.frames, pcm, frames))
					return false;
				if (last)
					vo.open = false;
				return true;
			}
		}
		for (int i = 0; i < m_nWait; i++)
		{
			Clip& c = m_wait[i];
			if (c.speaker == speaker && c.stream == stream && c.open)
			{
				if (!Extend(c.pcm, c.frames, pcm, frames))
					return false;
				if (last)
					c.open = false;
				return true;
			}
		}
		H9TTS_MIX_FREE(pcm);
		return false;
	}

	// Writes frames stereo frames (interleaved, 2 * frames samples) to out: the sum of every voice at its gain, limited. Waiting
	// lines get a voice first when one is free. Returns the voices that were playing at the start of the block, 0 for a silent one.
	int Mix(short* out, int frames, unsigned now)
	{
		Promote(now);
		const int sounding = Playing();
		for (int i = 0; i < frames; i++)
		{
			float l = 0.0f;
			float r = 0.0f;
			for (int v = 0; v < kMixMaxVoices; v++)
			{
				Voice& vo = m_voice[v];
				if (!vo.active)
					continue;
				bool ended = false;
				if (vo.stopping)
					ended = vo.stopLeft <= 1;
				if (vo.pos >= vo.frames)
				{
					// a streamed line has played all that has arrived: silence, the voice waits for the next piece (or the end)
					if (vo.open && !vo.stopping)
						continue;
					EndVoice(vo);
					continue;
				}
				float env = 1.0f;
				if (vo.pos < kMixFadeFrames)
					env = (float)(vo.pos + 1) / (float)(kMixFadeFrames + 1);
				const int left = vo.frames - vo.pos;
				if (!vo.open && left <= kMixFadeFrames)
				{
					const float tail = (float)left / (float)(kMixFadeFrames + 1);
					if (tail < env)
						env = tail;
				}
				if (vo.stopping)
				{
					env *= (float)vo.stopLeft / (float)kMixStopFrames;
					vo.stopLeft--;
				}
				const float s = (float)vo.pcm[vo.pos] * env;
				l += s * vo.gainL;
				r += s * vo.gainR;
				vo.pos++;
				if (ended || (vo.pos >= vo.frames && !vo.open))
					EndVoice(vo);
			}
			out[2 * i] = Soft(l);
			out[2 * i + 1] = Soft(r);
		}
		return sounding;
	}

	// Everything fades out and the waiting lines go: the voices end within kMixStopFrames.
	void StopAll()
	{
		for (int i = 0; i < m_nWait; i++)
			H9TTS_MIX_FREE(m_wait[i].pcm);
		m_nWait = 0;
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			Voice& vo = m_voice[v];
			if (vo.active && !vo.stopping)
			{
				vo.stopping = true;
				vo.stopLeft = kMixStopFrames;
			}
		}
	}

	// Everything goes at once (no fade): for a platform that has lost its output.
	void Clear()
	{
		for (int i = 0; i < m_nWait; i++)
			H9TTS_MIX_FREE(m_wait[i].pcm);
		m_nWait = 0;
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			if (m_voice[v].active)
				EndVoice(m_voice[v]);
		}
	}

	int Playing() const
	{
		int n = 0;
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			if (m_voice[v].active)
				n++;
		}
		return n;
	}

	int Waiting() const
	{
		return m_nWait;
	}

	bool Idle() const
	{
		return m_nWait == 0 && Playing() == 0;
	}

	// How many voices this speaker has playing: 0 or 1, since his lines never overlap.
	int VoicesOf(int speaker) const
	{
		int n = 0;
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			if (m_voice[v].active && m_voice[v].speaker == speaker)
				n++;
		}
		return n;
	}

	// Whether this speaker has a line playing.
	bool SpeakerPlaying(int speaker) const
	{
		return VoicesOf(speaker) > 0;
	}

private:
	struct Voice
	{
		bool active;
		bool stopping;
		int speaker;
		short* pcm;
		int frames;
		int pos;
		float gainL;
		float gainR;
		int stopLeft; // frames of the fade-out that are left, while stopping
		int stream;   // the streamed line this voice plays (0: a whole line)
		bool open;    // more pieces of the streamed line are still to come
	};

	// buf (frames samples) gets add (n samples) after them: a new buffer holds both, the old two are let go of. False when there is no memory.
	static bool Extend(short*& buf, int& frames, short* add, int n)
	{
		if (n == 0)
		{
			H9TTS_MIX_FREE(add);
			return true;
		}
		short* made = (short*)H9TTS_MIX_ALLOC((size_t)(frames + n) * sizeof(short));
		if (!made)
		{
			H9TTS_MIX_FREE(add);
			return false;
		}
		memcpy(made, buf, (size_t)frames * sizeof(short));
		memcpy(made + frames, add, (size_t)n * sizeof(short));
		H9TTS_MIX_FREE(buf);
		H9TTS_MIX_FREE(add);
		buf = made;
		frames += n;
		return true;
	}

	Voice m_voice[kMixMaxVoices];
	Clip m_wait[kMixMaxWaiting]; // oldest first
	int m_nWait;

	static int ClampLimit(int limit)
	{
		return limit < 1 ? 1 : (limit > kMixMaxVoices ? kMixMaxVoices : limit);
	}

	// A sum in 16-bit units to a sample: untouched below the knee, then bent toward full scale without ever reaching it.
	static short Soft(float x)
	{
		const float a = x < 0.0f ? -x : x;
		float y = a;
		if (a > kMixKnee)
		{
			const float room = 32767.0f - kMixKnee;
			const float over = (a - kMixKnee) / room;
			y = kMixKnee + room * (over / (1.0f + over));
		}
		if (x < 0.0f)
			y = -y;
		return (short)(y >= 0.0f ? y + 0.5f : y - 0.5f);
	}

	void EndVoice(Voice& vo)
	{
		H9TTS_MIX_FREE(vo.pcm);
		memset(&vo, 0, sizeof(vo));
	}

	void Start(const Clip& clip)
	{
		for (int v = 0; v < kMixMaxVoices; v++)
		{
			Voice& vo = m_voice[v];
			if (vo.active)
				continue;
			memset(&vo, 0, sizeof(vo));
			vo.active = true;
			vo.speaker = clip.speaker;
			vo.pcm = clip.pcm;
			vo.frames = clip.frames;
			vo.gainL = clip.gainL;
			vo.gainR = clip.gainR;
			vo.stream = clip.stream;
			vo.open = clip.open && clip.stream > 0;
			return;
		}
		H9TTS_MIX_FREE(clip.pcm); // not reached: no limit is above kMixMaxVoices
	}

	// A speaker's waiting line goes when a newer one of his comes.
	void RemoveWaiting(int speaker)
	{
		for (int i = 0; i < m_nWait; i++)
		{
			if (m_wait[i].speaker == speaker)
			{
				H9TTS_MIX_FREE(m_wait[i].pcm);
				DropWaiting(i);
				return;
			}
		}
	}

	void DropWaiting(int index)
	{
		for (int i = index; i + 1 < m_nWait; i++)
			m_wait[i] = m_wait[i + 1];
		m_nWait--;
	}

	// Puts a line on the waiting list. When the list is full the quietest line goes, the oldest of equals: a waiting one, or the
	// newcomer when it is quieter than all of them. False when the newcomer is the one that went.
	bool Enqueue(const Clip& clip)
	{
		if (m_nWait == kMixMaxWaiting)
		{
			int victim = 0;
			for (int i = 1; i < m_nWait; i++)
			{
				if (m_wait[i].priority < m_wait[victim].priority)
					victim = i;
			}
			if (clip.priority < m_wait[victim].priority)
			{
				H9TTS_MIX_FREE(clip.pcm);
				return false;
			}
			H9TTS_MIX_FREE(m_wait[victim].pcm);
			DropWaiting(victim);
		}
		m_wait[m_nWait++] = clip;
		return true;
	}

	// Waiting lines, oldest first: one that has waited too long goes, one whose speaker is silent and for whom a voice is free starts.
	void Promote(unsigned now)
	{
		for (int i = 0; i < m_nWait;)
		{
			const Clip clip = m_wait[i];
			if ((int)(now - clip.arrived) > kMixMaxWaitMs)
			{
				H9TTS_MIX_FREE(clip.pcm);
				DropWaiting(i);
			}
			else if (!SpeakerPlaying(clip.speaker) && Playing() < ClampLimit(clip.limit))
			{
				DropWaiting(i);
				Start(clip);
			}
			else
			{
				i++;
			}
		}
	}
};
} // namespace h9tts
