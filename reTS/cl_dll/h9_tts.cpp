// ---- H9 text to speech ------------------------------------------------------------------------------------------
// The H9Tts message and the client's own limits on it. h9_tts.h is the outline; docs\TEXT_TO_SPEECH.txt the protocol.
//
//   byte    the speaker's slot, 1 to 255 (0: the server asking for this game's voice picks, see flags)
//   byte    the voice: 0 man, 1 woman, 2 Mech, 3 bot
//   byte    the volume, 0 to 100, from the distance to the speaker
//   byte    flags: bit 0, a gas mask muffles the voice; bit 1, with slot 0: send h9_ttsvoice (cl_h9_tts_myvoice and _mydepth);
//           bit 2, the line is global: sent to everyone whatever the distance, so it is heard from no direction
//   string  the words
//   byte    the variant the speaker asked others to hear him with (0: none)         } after the words, from a server that
//   char    the depth he asked for, -10 deeper to 10 higher                          } has them; an older message ends
//   char    the pan, -100 (his voice in your left ear) to 100, from where he is     } at the words
//   byte    1: the bot voice is a droid's (only the Kokoro voices tell a droid from a bot)  } after the pan, from a server that has it
//
// The speaking is the platform's (h9_tts_win.cpp, h9_tts_web.cpp); here the message is checked and the words cleaned.

#include "hud.h"
#include "cl_util.h"
#include "parsemsg.h"
#include "h9_tts.h"
#include "h9_tts_platform.h"

#include <string.h>
#include <stdio.h>
#include <chrono>
#include <random>

#define H9TTS_MAX_MSG 192     // bytes an H9Tts message may have
#define H9TTS_MIN_GAP 0.3f    // seconds between two lines of one speaker
#define H9TTS_MAX_RATE 8      // lines a second, from everyone together
#define H9TTS_MAX_VOLUME 2.0f // cl_h9_tts_volume's ceiling
#define H9TTS_MAX_VOICES 8    // cl_h9_tts_maxvoices' ceiling
#define H9TTS_DEF_VOICES 4    // and its default

namespace
{
cvar_t* s_cvEnabled; // cl_h9_tts: 0 hears no one
cvar_t* s_cvVolume;  // cl_h9_tts_volume: 1 is a voice as the distance leaves it
cvar_t* s_cvInfo;    // _h9tts: the userinfo key the server reads, 1 while this game speaks, else 0
cvar_t* s_cvVoice[4]; // cl_h9_tts_voice_man, _woman, _mech, _bot: the place in cl_h9_tts_voices of the voice picked, 0 leaves it to the game
cvar_t* s_cvRobot;   // cl_h9_tts_robot: 1 puts a Mech's and a bot's voice through the robot filter (where the platform can)
cvar_t* s_cvMuffle;  // cl_h9_tts_muffle: how strongly a gas mask muffles a voice, 0 not at all, 1 the standard, 2 heavy
cvar_t* s_cvPan;     // cl_h9_tts_pan: 1 places each voice in the ear it comes from (Windows), 0 plays them in the middle
cvar_t* s_cvMaxVoices; // cl_h9_tts_maxvoices: 1 to 8 voices at a time; a line beyond them waits for a voice and cuts none off
cvar_t* s_cvIndividual; // cl_h9_tts_individual: 1 gives each speaker who asked for no voice of his own one of his own, from his slot
cvar_t* s_cvMyVoice; // cl_h9_tts_myvoice: the variant of the voice others hear from this player, 0 leaving it to their games
cvar_t* s_cvMyDepth; // cl_h9_tts_mydepth: how deep (below 0) or high (above 0) others hear him, -10 to 10
cvar_t* s_cvVoiceSet; // cl_h9_tts_voice_set: 1 once this player has a voice of his own, chosen or given at random the first time
cvar_t* s_cvEngine;  // cl_h9_tts_engine: system (the machine's own voices), auto (the Kokoro voices when they are ready), kokoro (those only)
cvar_t* s_cvThreads; // cl_h9_tts_threads: the threads the Kokoro helper synthesises with, 0 leaving it to the game

bool s_bInited = false;
bool s_bWasEnabled = true; // cl_h9_tts as the last frame had it: turning it off stops what is playing
float s_flLast[256]; // client time of each speaker's last line
float s_flRateStart = 0.0f;
int s_iRateCount = 0;

// This game's voice picks, sent to the server (h9_ttsvoice) when it asks for them and when they change. -1000: not sent yet.
bool s_bServerAsked = false; // the server has asked on this map, so it has the plugin
int s_iSentVariant = -1000;
int s_iSentDepth = -1000;

bool Enabled()
{
	return s_cvEnabled && s_cvEnabled->value != 0.0f;
}

// The voice a player picked for this kind of speaker (a place in cl_h9_tts_voices, from 1), 0 when he picked none. A Mech and a bot
// with no pick of their own speak in the man's voice, whichever the man's is.
int Choice(int voice)
{
	if (voice < 0 || voice > 3)
		return 0;
	int n = s_cvVoice[voice] ? (int)s_cvVoice[voice]->value : 0;
	if (n <= 0 && (voice == H9TTS_VOICE_MECH || voice == H9TTS_VOICE_BOT) && s_cvVoice[H9TTS_VOICE_MAN])
		n = (int)s_cvVoice[H9TTS_VOICE_MAN]->value;
	return n > 0 ? n : 0;
}

bool Robot()
{
	return s_cvRobot && s_cvRobot->value != 0.0f;
}

int ClampInt(int v, int lo, int hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

float ClampFloat(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

float CvarValue(const cvar_t* cv, float fallback)
{
	return cv ? cv->value : fallback;
}

// This player's own picks, the ones he asks others to hear him with.
int MyVariant()
{
	return ClampInt((int)CvarValue(s_cvMyVoice, 0.0f), 0, 99);
}

int MyDepth()
{
	return ClampInt((int)CvarValue(s_cvMyDepth, 0.0f), -10, 10);
}

// A player who has never chosen a voice is given one, once: a variant at random (1 to 99, which wraps round the variants of his kind on each listener's
// machine) and, when he has set no depth either, a small step of depth (-2 to 2). Both are written to cl_h9_tts_myvoice and cl_h9_tts_mydepth, which are
// saved with his config, and cl_h9_tts_voice_set remembers it, so the players of a server do not all sound alike and each keeps the voice he was given on every
// server and in every listener's game. A pick he made is kept as it is, and a 0 he sets afterwards stays a 0.
void AssignVoiceOnce()
{
	static bool done = false;
	if (done || !s_cvVoiceSet || !s_cvMyVoice || !s_cvMyDepth)
		return;
	done = true;
	if (s_cvVoiceSet->value != 0.0f)
		return;
	const bool fresh = MyVariant() == 0 && MyDepth() == 0;
	std::random_device rd;
	std::mt19937 gen(rd() ^ (unsigned)std::chrono::steady_clock::now().time_since_epoch().count());
	char value[16];
	if (MyVariant() == 0)
	{
		snprintf(value, sizeof(value), "%d", 1 + (int)(gen() % 99));
		gEngfuncs.Cvar_Set("cl_h9_tts_myvoice", value);
	}
	if (fresh)
	{
		snprintf(value, sizeof(value), "%d", (int)(gen() % 5) - 2);
		gEngfuncs.Cvar_Set("cl_h9_tts_mydepth", value);
	}
	gEngfuncs.Cvar_Set("cl_h9_tts_voice_set", "1");
}

// cl_h9_tts_engine as a number: 0 system (the default), 1 auto, 2 kokoro. The first letter decides, and 0, 1 and 2 are taken as they are.
int EngineMode()
{
	const char* s = (s_cvEngine && s_cvEngine->string) ? s_cvEngine->string : "system";
	switch (s[0])
	{
	case 'a':
	case 'A':
	case '1':
		return 1;
	case 'k':
	case 'K':
	case '2':
		return 2;
	default:
		return 0;
	}
}

int ThreadsSetting()
{
	return ClampInt((int)CvarValue(s_cvThreads, 0.0f), 0, 16);
}

// Fills in the shared part of a line: the cvars that do not depend on who speaks.
void FillSettings(H9TtsLine& line)
{
	line.muffle = ClampFloat(CvarValue(s_cvMuffle, 1.0f), 0.0f, 2.0f);
	line.maxVoices = ClampInt((int)CvarValue(s_cvMaxVoices, (float)H9TTS_DEF_VOICES), 1, H9TTS_MAX_VOICES);
	line.robot = Robot();
	line.engine = EngineMode();
	line.threads = ThreadsSetting();
}

// A speaker who asked for no voice of his own (variant 0) still gets one: the n-th voice of his kind, n from his slot, and a
// small step off the voice's pitch, so that the players of a room do not all sound alike. A listener's own pick overrides the voice
// but not the pitch step.
void IndividualVoice(int slot, int& variant, int& depth)
{
	if (variant > 0 || CvarValue(s_cvIndividual, 1.0f) == 0.0f)
		return;
	variant = 1 + (slot * 5 + 3) % 7;
	depth += ((slot * 7) % 9) - 4;
}

// The words as a voice will have them: a control character is a space, a run of spaces is one, the ends are trimmed
// and the line is cut to the size of out, never inside a multi-byte character. False when nothing is left to say:
// no letter, digit or non-ASCII character in it.
bool CleanText(const char* in, char* out, int size)
{
	int n = 0;
	bool space = true;
	for (; *in && n < size - 1; in++)
	{
		unsigned char c = (unsigned char)*in;
		if (c < 32 || c == 127)
			c = ' ';
		if (c == ' ')
		{
			if (!space)
			{
				out[n++] = ' ';
				space = true;
			}
			continue;
		}
		space = false;
		out[n++] = (char)c;
	}
	// the cut fell inside a multi-byte character: the character goes
	if (*in && (((unsigned char)*in) & 0xC0) == 0x80)
	{
		while (n > 0 && (((unsigned char)out[n - 1]) & 0xC0) == 0x80)
			n--;
		if (n > 0)
			n--;
	}
	while (n > 0 && out[n - 1] == ' ')
		n--;
	out[n] = 0;

	for (int i = 0; i < n; i++)
	{
		const unsigned char c = (unsigned char)out[i];
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c >= 128)
			return true;
	}
	return false;
}

// ---- the message ------------------------------------------------------------------------------------------------

int __MsgFunc_H9Tts(const char* pszName, int iSize, void* pbuf)
{
	if (iSize < 5 || iSize > H9TTS_MAX_MSG)
		return 1;

	BEGIN_READ(pbuf, iSize);
	const int slot = READ_BYTE();
	int voice = READ_BYTE();
	const int volume = READ_BYTE();
	const int flags = READ_BYTE();

	// slot 0 with bit 1: the server has the plugin and asks for this game's voice picks (they go in Think, whichever way cl_h9_tts is)
	if (slot == 0)
	{
		if (flags & 2)
		{
			s_bServerAsked = true;
			s_iSentVariant = -1000;
			s_iSentDepth = -1000;
		}
		return 1;
	}

	if (!Enabled() || !H9TtsPlat_Available())
		return 1;

	// At most H9TTS_MAX_RATE lines a second from everyone together; the rest are dropped.
	const float now = gHUD.m_flTime;
	if (now - s_flRateStart >= 1.0f || now < s_flRateStart)
	{
		s_flRateStart = now;
		s_iRateCount = 0;
	}
	if (++s_iRateCount > H9TTS_MAX_RATE)
		return 1;

	const char* words = READ_STRING();

	if (slot > 255 || !words)
		return 1;

	// what follows the words, from a server that sends it: the speaker's variant and depth, and where he is
	int variant = 0;
	int depth = 0;
	int pan = 0;
	int detail = 0;
	const int used = 4 + (int)strlen(words) + 1;
	if (iSize - used >= 3)
	{
		variant = ClampInt(READ_BYTE(), 0, 99);
		depth = ClampInt(READ_CHAR(), -10, 10);
		pan = ClampInt(READ_CHAR(), -100, 100);
	}
	if (iSize - used >= 4)
		detail = READ_BYTE(); // 1: the bot voice is a droid's

	// the server decides who is sent a line (the speaker too while h9_tts_self is 1); one speaker's lines come no closer than H9TTS_MIN_GAP
	if (now >= s_flLast[slot] && now - s_flLast[slot] < H9TTS_MIN_GAP)
		return 1;

	if (voice < H9TTS_VOICE_MAN || voice > H9TTS_VOICE_BOT)
		voice = H9TTS_VOICE_MAN;

	float user = s_cvVolume ? s_cvVolume->value : 1.0f;
	if (user < 0.0f)
		user = 0.0f;
	if (user > H9TTS_MAX_VOLUME)
		user = H9TTS_MAX_VOLUME;
	const float level = (volume > 100 ? 100 : volume) / 100.0f * user;
	if (level < 0.01f)
		return 1;

	char text[H9TTS_TEXT_MAX + 1];
	if (!CleanText(words, text, sizeof(text)))
		return 1;

	IndividualVoice(slot, variant, depth);

	H9TtsLine line;
	memset(&line, 0, sizeof(line));
	FillSettings(line);
	line.speaker = slot;
	line.voice = voice;
	line.droid = voice == H9TTS_VOICE_BOT && detail == 1;
	line.muffled = (flags & 1) != 0;
	line.global = (flags & 4) != 0;
	line.volume = level;
	line.pan = (!line.global && CvarValue(s_cvPan, 1.0f) != 0.0f) ? pan / 100.0f : 0.0f;
	line.text = text;
	line.choice = Choice(voice);
	line.variant = variant;
	line.depth = ClampInt(depth, -H9TTS_DEPTH_MAX, H9TTS_DEPTH_MAX);

	s_flLast[slot] = now;
	H9TtsPlat_Speak(line);
	return 1;
}

// cl_h9_tts_voices: the voices this machine has, numbered, and the ones in use.
void CmdVoices()
{
	if (!H9TtsPlat_Available())
	{
		gEngfuncs.Con_Printf("text to speech: this machine has no voice to speak with\n");
		return;
	}
	const int n = H9TtsPlat_VoiceCount();
	if (n <= 0)
	{
		gEngfuncs.Con_Printf("text to speech: the voices are still being listed (or none is installed); try again in a moment\n");
		return;
	}
	gEngfuncs.Con_Printf("text to speech: %d voice(s) on this machine. Give a number to cl_h9_tts_voice_man, _woman, _mech or _bot (0: the game chooses)\n", n);
	for (int i = 1; i <= n; i++)
	{
		char name[128];
		char gender = '?';
		if (!H9TtsPlat_VoiceInfo(i, name, sizeof(name), &gender))
			continue;
		gEngfuncs.Con_Printf("  %2d  %s%s\n", i, name, gender == 'F' ? "  (woman's)" : (gender == 'M' ? "  (man's)" : ""));
	}
	gEngfuncs.Con_Printf("now: man %d, woman %d, mech %d, bot %d (0: a man's voice for a man, a woman's for a woman; a Mech and a bot use the man's)\n",
		s_cvVoice[0] ? (int)s_cvVoice[0]->value : 0, s_cvVoice[1] ? (int)s_cvVoice[1]->value : 0,
		s_cvVoice[2] ? (int)s_cvVoice[2]->value : 0, s_cvVoice[3] ? (int)s_cvVoice[3]->value : 0);
}

// Whether two words are the same, whatever their case (the browser build has no stricmp).
bool SameWord(const char* a, const char* b)
{
	for (; *a && *b; a++, b++)
	{
		const char x = (*a >= 'A' && *a <= 'Z') ? (char)(*a + 32) : *a;
		const char y = (*b >= 'A' && *b <= 'Z') ? (char)(*b + 32) : *b;
		if (x != y)
			return false;
	}
	return *a == *b;
}

// cl_h9_tts_test <man|woman|mech|bot> [muffled] <words>: speaks the words in that kind of voice, with the picks in force.
void CmdTest()
{
	const int argc = gEngfuncs.Cmd_Argc();
	const char* kinds[4] = { "man", "woman", "mech", "bot" };
	int voice = -1;
	bool droid = false;
	bool muffled = false;
	int first = 2;
	if (argc >= 2)
	{
		for (int i = 0; i < 4; i++)
		{
			if (SameWord(gEngfuncs.Cmd_Argv(1), kinds[i]))
				voice = i;
		}
		if (SameWord(gEngfuncs.Cmd_Argv(1), "droid"))
		{
			voice = H9TTS_VOICE_BOT;
			droid = true;
		}
	}
	if (voice >= 0 && argc >= 3 && SameWord(gEngfuncs.Cmd_Argv(2), "muffled"))
	{
		muffled = true;
		first = 3;
	}
	if (voice < 0 || argc <= first)
	{
		gEngfuncs.Con_Printf("usage: cl_h9_tts_test <man|woman|mech|bot|droid> [muffled] <words>   (cl_h9_tts_voices lists the voices)\n");
		return;
	}
	if (!H9TtsPlat_Available())
	{
		gEngfuncs.Con_Printf("text to speech: this machine has no voice to speak with\n");
		return;
	}
	char joined[H9TTS_TEXT_MAX * 2];
	joined[0] = 0;
	for (int i = first; i < argc; i++)
	{
		if (joined[0])
			strncat(joined, " ", sizeof(joined) - strlen(joined) - 1);
		strncat(joined, gEngfuncs.Cmd_Argv(i), sizeof(joined) - strlen(joined) - 1);
	}
	char text[H9TTS_TEXT_MAX + 1];
	if (!CleanText(joined, text, sizeof(text)))
		return;
	float user = s_cvVolume ? s_cvVolume->value : 1.0f;
	if (user < 0.0f)
		user = 0.0f;
	if (user > H9TTS_MAX_VOLUME)
		user = H9TTS_MAX_VOLUME;

	// the test speaks as this player does to others: with his own variant and depth, in the middle
	H9TtsLine line;
	memset(&line, 0, sizeof(line));
	FillSettings(line);
	line.speaker = 255;
	line.voice = voice;
	line.droid = droid;
	line.muffled = muffled;
	line.volume = user;
	line.text = text;
	line.choice = Choice(voice);
	line.variant = MyVariant();
	line.depth = MyDepth();
	H9TtsPlat_KokoroStart(line.engine, line.threads, true);
	H9TtsPlat_Speak(line);
}

// cl_h9_tts_state: which voices speak, and the state of the Kokoro helper.
void CmdState()
{
	static const char* names[3] = { "system", "auto", "kokoro" };
	gEngfuncs.Con_Printf("text to speech: cl_h9_tts %d, cl_h9_tts_engine %s, cl_h9_tts_threads %d (0: the game chooses), the system voice %s\n",
		Enabled() ? 1 : 0, names[EngineMode()], ThreadsSetting(), H9TtsPlat_Available() ? "can speak" : "cannot speak here");
	char out[2048];
	if (H9TtsPlat_KokoroState(out, sizeof(out)) > 0)
		gEngfuncs.Con_Printf("%s", out);
	else
		gEngfuncs.Con_Printf("this platform has no Kokoro voices\n");
}

// cl_h9_tts_reload: the Kokoro helper is stopped and started again (a changed thread setting, a helper that was replaced).
void CmdReload()
{
	H9TtsPlat_KokoroReload();
	gEngfuncs.Con_Printf("text to speech: the Kokoro helper is restarted\n");
}

// _h9tts is what the server reads: 1 while this game will speak a line it is sent, else 0. It follows cl_h9_tts and
// whether the machine has a voice, so a game that cannot or will not speak is sent nothing.
void SyncUserinfo()
{
	if (!s_cvInfo)
		return;
	char want[2];
	want[0] = (Enabled() && H9TtsPlat_Available()) ? '1' : '0';
	want[1] = 0;
	if (!s_cvInfo->string || 0 != strcmp(s_cvInfo->string, want))
		gEngfuncs.Cvar_Set("_h9tts", want);
}

// h9_ttsvoice <variant> <depth>: this player's picks, for the server to put into the lines others hear from him. Sent once the
// server has asked on this map (it asks as each player joins, and only a server that has the plugin does), and again whenever
// one of the two cvars changes. Not through the userinfo: a game's userinfo is a 256-byte string that is full already.
void SyncVoicePrefs()
{
	if (!s_bServerAsked)
		return;
	const int variant = MyVariant();
	const int depth = MyDepth();
	if (variant == s_iSentVariant && depth == s_iSentDepth)
		return;
	char cmd[48];
	snprintf(cmd, sizeof(cmd), "h9_ttsvoice %d %d", variant, depth);
	gEngfuncs.pfnServerCmd(cmd);
	s_iSentVariant = variant;
	s_iSentDepth = depth;
}

class CHudH9Tts : public CHudBase
{
public:
	bool Init() override
	{
		m_iFlags |= HUD_ACTIVE;
		return true;
	}
	bool VidInit() override
	{
		// a new map is a new server state: the plugin starts without this game's picks and asks for them again
		s_bServerAsked = false;
		s_iSentVariant = -1000;
		s_iSentDepth = -1000;
		return true;
	}
	void Think() override
	{
		AssignVoiceOnce();
		SyncUserinfo();
		SyncVoicePrefs();
		// the Kokoro voices: the engine the player chose, and the helper started ahead of the first line on a server that speaks
		H9TtsPlat_KokoroStart(Enabled() ? EngineMode() : 0, ThreadsSetting(), s_bServerAsked);
		H9TtsPlat_KokoroFrame(gHUD.m_flTimeDelta);
		// cl_h9_tts 0 is silence now: what is playing fades out and what waits goes
		const bool enabled = Enabled();
		if (s_bWasEnabled && !enabled)
			H9TtsPlat_Stop();
		s_bWasEnabled = enabled;
	}
};
CHudH9Tts s_Hud;
} // namespace

// ---- the hooks --------------------------------------------------------------------------------------------------

void H9Tts_Init()
{
	if (s_bInited)
		return;
	s_bInited = true;
	s_cvEnabled = CVAR_CREATE("cl_h9_tts", "1", FCVAR_ARCHIVE);
	s_cvVolume = CVAR_CREATE("cl_h9_tts_volume", "1.0", FCVAR_ARCHIVE);
	s_cvVoice[H9TTS_VOICE_MAN] = CVAR_CREATE("cl_h9_tts_voice_man", "0", FCVAR_ARCHIVE);
	s_cvVoice[H9TTS_VOICE_WOMAN] = CVAR_CREATE("cl_h9_tts_voice_woman", "0", FCVAR_ARCHIVE);
	s_cvVoice[H9TTS_VOICE_MECH] = CVAR_CREATE("cl_h9_tts_voice_mech", "0", FCVAR_ARCHIVE);
	s_cvVoice[H9TTS_VOICE_BOT] = CVAR_CREATE("cl_h9_tts_voice_bot", "0", FCVAR_ARCHIVE);
	s_cvRobot = CVAR_CREATE("cl_h9_tts_robot", "1", FCVAR_ARCHIVE);
	s_cvMuffle = CVAR_CREATE("cl_h9_tts_muffle", "1.0", FCVAR_ARCHIVE);
	s_cvPan = CVAR_CREATE("cl_h9_tts_pan", "1", FCVAR_ARCHIVE);
	s_cvMaxVoices = CVAR_CREATE("cl_h9_tts_maxvoices", "4", FCVAR_ARCHIVE);
	s_cvIndividual = CVAR_CREATE("cl_h9_tts_individual", "1", FCVAR_ARCHIVE);
	s_cvMyVoice = CVAR_CREATE("cl_h9_tts_myvoice", "0", FCVAR_ARCHIVE);
	s_cvMyDepth = CVAR_CREATE("cl_h9_tts_mydepth", "0", FCVAR_ARCHIVE);
	s_cvVoiceSet = CVAR_CREATE("cl_h9_tts_voice_set", "0", FCVAR_ARCHIVE);
	s_cvEngine = CVAR_CREATE("cl_h9_tts_engine", "system", FCVAR_ARCHIVE);
	s_cvThreads = CVAR_CREATE("cl_h9_tts_threads", "0", FCVAR_ARCHIVE);
	H9TtsPlat_Init();
	s_cvInfo = CVAR_CREATE("_h9tts", (Enabled() && H9TtsPlat_Available()) ? "1" : "0", FCVAR_USERINFO);
	gEngfuncs.pfnHookUserMsg("H9Tts", __MsgFunc_H9Tts);
	gEngfuncs.pfnAddCommand("cl_h9_tts_voices", CmdVoices);
	gEngfuncs.pfnAddCommand("cl_h9_tts_test", CmdTest);
	gEngfuncs.pfnAddCommand("cl_h9_tts_state", CmdState);
	gEngfuncs.pfnAddCommand("cl_h9_tts_reload", CmdReload);
	s_Hud.Init();
	gHUD.AddHudElem(&s_Hud);
}

void H9Tts_Shutdown()
{
	if (!s_bInited)
		return;
	H9TtsPlat_Shutdown();
}

// A platform without the Kokoro voices (the browser keeps its own): nothing to start, nothing to report.
#if !H9TTS_HAVE_KOKORO
void H9TtsPlat_KokoroStart(int, int, bool)
{
}
void H9TtsPlat_KokoroFrame(double)
{
}
int H9TtsPlat_KokoroState(char*, int)
{
	return 0;
}
void H9TtsPlat_KokoroReload()
{
}
#endif

// A platform with no speech: the message is read and ignored, and _h9tts stays 0.
#ifndef H9TTS_HAVE_SPEECH
bool H9TtsPlat_Init()
{
	return false;
}
bool H9TtsPlat_Available()
{
	return false;
}
void H9TtsPlat_Shutdown()
{
}
int H9TtsPlat_VoiceCount()
{
	return 0;
}
bool H9TtsPlat_VoiceInfo(int, char*, int, char*)
{
	return false;
}
void H9TtsPlat_Speak(const H9TtsLine&)
{
}
void H9TtsPlat_Stop()
{
}
#endif
