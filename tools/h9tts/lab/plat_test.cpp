// plat_test -- the Windows speech layer of the client (reTS/cl_dll/h9_tts_win.cpp: the speech thread, SAPI, the Kokoro voices through the helper, the mixer and the
// sound card) run outside the game, to see when lines START TO SOUND when they arrive while the helper is making another one.
//
// h9_tts_win.cpp is compiled into this program whole (its mixer is read here, to see when a speaker's voice begins), the Kokoro code is linked as the client has it.
// Every line is spoken at a volume of 0.004, about -46 dB, which cannot be heard: the sound card is used but nothing is audible.
//
//   plat_test <scenario> <threads> [engine 1|2]
//
//   one      one line of 21 words at time 0
//   burst    the same line at 0, then a short line at 500 ms, a line of the pack at 800 ms, a short line at 1000 ms and another at 2500 ms, each of another speaker
//   chat     six lines of about ten words, one second apart, of six speakers
//   pack     a line of the pack while nothing else is going on, and a line of the pack while a long line is being made
//   flood    thirty lines in three seconds from eight speakers (some of the pack): the queue, the lines of a speaker that replace each
//            other, the serving of the lines that wait, the helper's refusals; nothing may hang or crash, every line is spoken by one voice or another or dropped
//
// For each line the time from its arrival to the first sound is printed, and what the Kokoro layer counted. The data folder is found as the lab finds it:
// <folder of the exe>\..\h9tts.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "h9_tts_win.cpp"

namespace
{
struct Event
{
	int atMs;
	int speaker;
	const char* text;
	const char* what;
};

const char* kLong = "Moving to the B site now so watch the north gate and the roof and tell me if you see them";

std::vector<Event> Scenario(const std::string& name)
{
	std::vector<Event> e;
	if (name == "one")
	{
		e.push_back({ 0, 1, kLong, "21 words, the helper" });
	}
	else if (name == "burst")
	{
		e.push_back({ 0, 1, kLong, "21 words, the helper" });
		e.push_back({ 500, 2, "Over here friend", "short, not in the pack" });
		e.push_back({ 800, 3, "gg everyone", "in the pack" });
		e.push_back({ 1000, 4, "Who took my rifle", "short, not in the pack" });
		e.push_back({ 2500, 5, "Nice shot", "short, not in the pack" });
	}
	else if (name == "chat")
	{
		e.push_back({ 0, 1, "The elevator is moving so they are coming up", "9 words" });
		e.push_back({ 1000, 2, "I will draw their fire while you flank them", "9 words" });
		e.push_back({ 2000, 3, "Somebody drop me a mag because I am almost out", "10 words" });
		e.push_back({ 3000, 4, "Check the vents because somebody might be hiding in there", "10 words" });
		e.push_back({ 4000, 5, "Fall back to the safe room and hold the corridor now", "11 words" });
		e.push_back({ 5000, 6, "Get ready because the next wave is coming from the east", "11 words" });
	}
	else if (name == "flood")
	{
		static const char* texts[] = { "gg everyone", "Who took my rifle", "The elevator is moving so they are coming up", "good game everyone", "Over here friend",
			"Somebody drop me a mag because I am almost out", "Nice shot", "Check the vents because somebody might be hiding in there", "I need a medic here",
			"Fall back to the safe room and hold the corridor now" };
		for (int i = 0; i < 30; i++)
			e.push_back({ i * 100, 1 + (i * 3) % 8, texts[(i * 7) % 10], "flood" });
	}
	else if (name == "pack")
	{
		e.push_back({ 0, 1, "good game everyone", "in the pack, nothing else going on" });
		e.push_back({ 3000, 2, kLong, "21 words, the helper" });
		e.push_back({ 3600, 3, "gg everyone", "in the pack, while the helper is busy" });
	}
	return e;
}

double NowMs(const std::chrono::steady_clock::time_point& t0)
{
	return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
}
} // namespace

int main(int argc, char** argv)
{
	if (argc < 3)
	{
		fprintf(stderr, "usage: plat_test one|burst|chat|pack|flood <threads> [engine 1|2]\n");
		return 2;
	}
	const std::vector<Event> events = Scenario(argv[1]);
	if (events.empty())
		return 2;
	// a hang ends the program (and the helper with it) instead of leaving two processes behind
	std::thread([]() {
		Sleep(150000);
		printf("plat_test: still running after 150 s, ended by its watchdog\n");
		fflush(stdout);
		ExitProcess(9);
	}).detach();
	const int threads = atoi(argv[2]);
	const int engine = argc > 3 ? atoi(argv[3]) : 1;
	if (!H9TtsPlat_Init())
	{
		printf("the platform could not start\n");
		return 3;
	}
	for (int i = 0; i < 100 && H9TtsPlat_VoiceCount() == 0; i++)
		Sleep(100);
	H9TtsPlat_KokoroStart(engine, threads, true);
	char state[4096];
	bool ready = false;
	for (int i = 0; i < 900 && !ready; i++)
	{
		H9TtsPlat_KokoroStart(engine, threads, true); // as the game does every frame: a helper whose start failed is started again when its pause is over
		H9TtsPlat_KokoroState(state, sizeof(state));
		ready = strstr(state, "helper: ready") != nullptr;
		if (!ready)
			Sleep(100);
	}
	if (!ready)
	{
		printf("the helper did not become ready:\n%s", state);
		H9TtsPlat_Shutdown();
		return 4;
	}
	// a line to warm the model, then the helper's busy time of it is out of its window
	{
		H9TtsLine w;
		memset(&w, 0, sizeof(w));
		w.speaker = 9;
		w.voice = H9TTS_VOICE_MAN;
		w.volume = 0.004f;
		w.text = "Ready now";
		w.variant = 1;
		w.maxVoices = 4;
		w.engine = engine;
		w.threads = threads;
		H9TtsPlat_Speak(w);
		Sleep(8000);
	}

	const std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
	std::vector<double> arrived(events.size(), -1.0), first(events.size(), -1.0);
	std::atomic<bool> stop(false);
	std::mutex times; // arrived and first are written by two threads
	std::thread monitor([&]() {
		while (!stop)
		{
			const double now = NowMs(t0);
			{
				std::lock_guard<std::mutex> lock(s_mixMtx);
				std::lock_guard<std::mutex> lt(times);
				for (size_t i = 0; i < events.size(); i++)
				{
					if (arrived[i] >= 0.0 && first[i] < 0.0 && s_mixer.SpeakerPlaying(events[i].speaker))
						first[i] = now;
				}
			}
			Sleep(2);
		}
	});
	for (size_t i = 0; i < events.size(); i++)
	{
		const double due = events[i].atMs;
		const double now = NowMs(t0);
		if (now < due)
			Sleep((DWORD)(due - now));
		H9TtsLine l;
		memset(&l, 0, sizeof(l));
		l.speaker = events[i].speaker;
		l.voice = H9TTS_VOICE_MAN;
		l.volume = 0.004f;
		l.text = events[i].text;
		l.variant = 1;
		l.maxVoices = 8;
		l.engine = engine;
		l.threads = threads;
		{
			std::lock_guard<std::mutex> lt(times);
			arrived[i] = NowMs(t0);
		}
		H9TtsPlat_Speak(l);
	}
	// until every line has sounded, or 20 s after the last
	for (int w = 0; w < 400; w++)
	{
		bool all = true;
		{
			std::lock_guard<std::mutex> lt(times);
			for (size_t i = 0; i < events.size(); i++)
				all = all && first[i] >= 0.0;
		}
		if (all)
			break;
		Sleep(50);
	}
	Sleep(7000); // the helper's last line is made to its end, so that the counters below have it
	stop = true;
	monitor.join();

	printf("%s, %d thread(s), engine %d, start budget %d ms\n", argv[1], threads, engine, h9tts::kokoro::kStartBudgetMs);
	printf("%2s %8s %-26s %22s  %s\n", "n", "arrives", "what", "first sound after (ms)", "text");
	for (size_t i = 0; i < events.size(); i++)
	{
		if (first[i] >= 0.0)
			printf("%2d %8.0f %-26s %22.0f  %.50s\n", (int)i + 1, arrived[i], events[i].what, first[i] - arrived[i], events[i].text);
		else
			printf("%2d %8.0f %-26s %22s  %.50s\n", (int)i + 1, arrived[i], events[i].what, "never", events[i].text);
	}
	H9TtsPlat_KokoroState(state, sizeof(state));
	printf("%s", state);
	H9TtsPlat_Shutdown();
	return 0;
}
