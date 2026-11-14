// ---- H9 text to speech in the browser ---------------------------------------------------------------------------
// The web client speaks with the page's own speechSynthesis (the Web Speech API). The browser exposes no audio data, so
// there is nothing to filter: a gas mask is approximated with a quieter, slightly lower and slower voice.
//
// One function, Module.h9tts, is installed the first time. As the client's other browser code does (freevgui's font.cpp),
// it is installed and called through emscripten_run_script: EM_JS symbols of a side module are not resolved by this
// loader. The text goes as an address in the heap and is read in the page with UTF8ToString.
//
// What the page's function does:
//   voice     the browser's voice for a man or a woman, chosen by name (the Web Speech API says nothing of gender) and by
//             language, the page's own and then English, a Natural or Neural voice (Edge's, for one) ahead of the rest; none
//             that matches and the default voice is used, a woman's with a higher pitch. A speaker who asked for a
//             variant gets the n-th of the voices of his kind. A Mech is the man's voice at pitch 0.5 and rate 0.8, a bot
//             the man's at 1.7 and 1.25.
//   depth     the speaker's depth: the pitch x (1 + 0.05 for each step)
//   gas mask  volume x (1 - 0.3 s), pitch x (1 - 0.1 s), rate x (1 - 0.05 s), s being cl_h9_tts_muffle (1 by default)
//   pan       none: the Web Speech API cannot place a voice in an ear
//   queue     the browser speaks one utterance at a time and cannot overlap two, whatever the page does, so lines wait their
//             turn: at most four wait, none longer than eight seconds after it arrived, and a full queue lets the quietest
//             go (the oldest of equals), before it was ever heard. A speaker's lines follow one another: a newer line of his
//             replaces his older one that still waits, and a line that is being spoken is left to finish. Nothing is cancelled
//             but by cl_h9_tts 0, or when a line has been going for 20 seconds (a voice that never reports its end)
//   absent    no speechSynthesis (or no SpeechSynthesisUtterance) and Module.h9ttsOk() is 0: _h9tts stays 0 and nothing
//             is sent; nothing in the page throws

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>

#include "h9_tts_platform.h"

static const char* H9_TTS_JS = R"JS(Module.h9tts = (function() {
	var synth = null, Utter = null;
	try {
		synth = window.speechSynthesis || null;
		Utter = window.SpeechSynthesisUtterance || null;
	} catch (e) {}
	var ok = !!(synth && Utter);
	var MAX_WAITING = 4;      // lines that wait for the voice
	var MAX_WAIT_MS = 8000;   // a line that has waited this long since it arrived is not worth saying
	var MAX_SPEAK_MS = 20000; // a line still going after this long is abandoned
	var voices = [];
	var queue = [];           // the lines that wait, oldest first
	var current = null;       // the line being spoken; it holds its utterance, so the browser cannot collect it before it ends
	var holdUntil = 0;        // after a cancel the browser is given a moment before the next utterance
	var FEMALE = /female|woman|zira|hazel|susan|samantha|victoria|karen|moira|tessa|fiona|allison|ava|serena|kate|jenny|aria|sonia|libby|emma|amy|joanna|salli|kimberly|ivy|nicole|raveena|natasha|hedda|helena|katja|paulina|monica|sabina/i;
	var MALE = /(^|[^a-z])male|david|mark|james|daniel|alex|fred|george|guy|ryan|thomas|oliver|arthur|ralph|rishi|eric|christopher|brian|matthew|joey|justin|kevin|russell|davis|jason|tony|stefan|hans|jorge|diego|pablo/i;

	function refresh() {
		try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
	}
	if (ok) {
		refresh();
		try { synth.addEventListener("voiceschanged", refresh); } catch (e) {}
	}

	// A voice of this gender: a Natural or Neural one ahead of the rest, the language of the page ahead of English ahead of any other;
	// null when none matches. A player's pick (a place in the browser's list, from 1) comes first when there is such a voice, then
	// the speaker's variant (the n-th of the matching voices, best first, wrapping round).
	function pick(wantFemale, choice, variant) {
		if (choice > 0 && choice <= voices.length) return voices[choice - 1];
		var lang = ((navigator.language || "en") + "").toLowerCase().slice(0, 2);
		var found = [];
		for (var i = 0; i < voices.length; i++) {
			var v = voices[i], name = v.name || "", l = (v.lang || "").toLowerCase();
			var f = FEMALE.test(name), m = !f && MALE.test(name);
			if (wantFemale ? !f : !m) continue;
			var score = (/natural|neural/i.test(name) ? 12 : (/online/i.test(name) ? 6 : 0)) + (l.slice(0, 2) === lang ? 2 : 0)
				+ (l === "en-us" ? 2 : 0) + (l.slice(0, 2) === "en" ? 1 : 0) + (v.localService ? 1 : 0);
			found.push({ voice: v, score: score, at: i });
		}
		if (!found.length) return null;
		found.sort(function(a, b) { return b.score - a.score || a.at - b.at; });
		return found[variant > 0 ? (variant - 1) % found.length : 0].voice;
	}

	function start(line) {
		var u;
		try { u = new Utter(line.text); } catch (e) { return; }
		var female = line.voice === 1;
		var v = pick(female, line.choice, line.variant);
		var pitch = 1, rate = 1;
		if (v) u.voice = v;
		else if (female) pitch = 1.3;
		if (line.voice === 2) { pitch = 0.5; rate = 0.8; }
		else if (line.voice === 3) { pitch = 1.7; rate = 1.25; }
		pitch *= 1 + line.depth * 0.05;
		var volume = line.volume;
		if (line.muffled) {
			var s = Math.max(0, Math.min(2, line.muffle));
			volume *= 1 - 0.3 * s; pitch *= 1 - 0.1 * s; rate *= 1 - 0.05 * s;
		}
		u.volume = Math.max(0, Math.min(1, volume));
		u.pitch = Math.max(0, Math.min(2, pitch));
		u.rate = Math.max(0.1, Math.min(4, rate));
		var done = function() { if (current === line) { current = null; pump(); } };
		u.onend = done;
		u.onerror = done;
		line.utter = u;
		line.began = Date.now();
		current = line;
		try { synth.speak(u); } catch (e) { current = null; }
	}

	function pump() {
		var wait = holdUntil - Date.now();
		if (wait > 0) { if (!current && queue.length) setTimeout(pump, wait + 10); return; }
		while (!current && queue.length) {
			var line = queue.shift();
			if (Date.now() - line.arrived > MAX_WAIT_MS) continue;
			start(line);
		}
	}

	function cancel() {
		try { synth.cancel(); } catch (e) {}
		current = null;
		holdUntil = Date.now() + 250;
	}

	function add(speaker, text, voice, muffled, volume, choice, variant, depth, muffle) {
		if (!ok) return 0;
		var now = Date.now();
		if (current && now - current.began > MAX_SPEAK_MS) cancel();
		for (var i = queue.length - 1; i >= 0; i--) {
			if (queue[i].speaker === speaker) queue.splice(i, 1);
		}
		queue.push({ speaker: speaker, text: text, voice: voice, muffled: muffled !== 0, volume: volume, choice: choice | 0,
			variant: variant | 0, depth: Math.max(-12, Math.min(12, depth | 0)), muffle: muffle, arrived: now, began: 0, utter: null });
		while (queue.length > MAX_WAITING) {
			var victim = 0;
			for (var j = 1; j < queue.length; j++) {
				if (queue[j].volume < queue[victim].volume) victim = j;
			}
			queue.splice(victim, 1);
		}
		pump();
		return 1;
	}

	Module.h9ttsStop = function() {
		if (!ok) return;
		queue.length = 0;
		cancel();
	};
	Module.h9ttsVoiceCount = function() { return ok ? (refresh(), voices.length) : 0; };
	Module.h9ttsVoiceName = function(i) {
		var v = voices[i - 1];
		if (!v) return "";
		var name = v.name || "";
		var f = FEMALE.test(name), m = !f && MALE.test(name);
		return (f ? "F" : (m ? "M" : "?")) + "|" + name + (v.lang ? " (" + v.lang + ")" : "");
	};
	return function(textPtr, speaker, voice, muffled, volume, choice, variant, depth, muffle) {
		try { return add(speaker, UTF8ToString(textPtr), voice, muffled, volume, choice, variant, depth, muffle); } catch (e) { return 0; }
	};
})();
Module.h9ttsOk = function() {
	try { return (window.speechSynthesis && window.SpeechSynthesisUtterance) ? 1 : 0; } catch (e) { return 0; }
};)JS";

static bool s_bReady = false;

bool H9TtsPlat_Init()
{
	emscripten_run_script(H9_TTS_JS);
	s_bReady = emscripten_run_script_int("Module.h9ttsOk()") != 0;
	return s_bReady;
}

bool H9TtsPlat_Available()
{
	return s_bReady;
}

void H9TtsPlat_Shutdown()
{
}

int H9TtsPlat_VoiceCount()
{
	return s_bReady ? emscripten_run_script_int("Module.h9ttsVoiceCount()") : 0;
}

bool H9TtsPlat_VoiceInfo(int index, char* name, int size, char* gender)
{
	char call[64];
	if (!s_bReady || index < 1 || !name || size < 2)
		return false;
	snprintf(call, sizeof(call), "Module.h9ttsVoiceName(%d)", index);
	const char* s = emscripten_run_script_string(call);
	if (!s || !s[0] || s[1] != '|')
		return false;
	if (gender)
		*gender = s[0];
	snprintf(name, (size_t)size, "%s", s + 2);
	return true;
}

// The browser gives no audio to filter, so robot has nothing to act on here: a Mech and a bot keep their pitch and rate. It has no
// pan either, so global is not read, and it speaks one line at a time whatever the page does, so maxVoices is not read.
void H9TtsPlat_Speak(const H9TtsLine& line)
{
	char call[192];
	if (!s_bReady || !line.text || !line.text[0] || line.speaker < 1 || line.speaker > 255)
		return;
	snprintf(call, sizeof(call), "Module.h9tts(%u,%d,%d,%d,%.3f,%d,%d,%d,%.2f)", (unsigned)(uintptr_t)line.text, line.speaker, line.voice,
		line.muffled ? 1 : 0, (double)line.volume, line.choice > 0 ? line.choice : 0, line.variant > 0 ? line.variant : 0, line.depth,
		(double)line.muffle);
	emscripten_run_script(call);
}

void H9TtsPlat_Stop()
{
	if (s_bReady)
		emscripten_run_script("Module.h9ttsStop()");
}

#endif // __EMSCRIPTEN__
