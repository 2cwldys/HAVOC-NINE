// Checks the per-gamemode key layouts' logic (h9_keymap_calc.h) with no game: key names against keydefs.h, a bind line's parsing, what a press, a
// repeat and a release come to, a key that is not listed, the keys that are never taken, the release of held keys when the mode ends, and the two
// shipped files (game/ts/h9/keys).
//   cmake --build <dir> --target keymap_test --config Release, then run keymap_test
#include "../h9_keymap_calc.h"
#include "../../public/keydefs.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>

using namespace h9keys;

static int g_failed = 0, g_checked = 0;
#define CHECK(what) \
	do \
	{ \
		g_checked++; \
		if (!(what)) \
		{ \
			g_failed++; \
			printf("FAILED line %d: %s\n", __LINE__, #what); \
		} \
	} while (0)

static bool Is(const Action& a, bool swallow, const char* line)
{
	if (a.swallow != swallow)
		return false;
	if (line == nullptr)
		return !a.run;
	return a.run && strcmp(a.line, line) == 0;
}

static char* ReadFile(const char* name)
{
	char path[512];
	// __FILE__ is .../cl_dll/tests/keymap_test.cpp
	snprintf(path, sizeof(path), "%s", __FILE__);
	char* slash = strrchr(path, '/');
	char* back = strrchr(path, '\\');
	if (back > slash)
		slash = back;
	if (slash)
		*slash = 0; // .../cl_dll/tests
	char full[640];
	snprintf(full, sizeof(full), "%s/../../game/ts/h9/keys/%s", path, name);
	FILE* f = fopen(full, "rb");
	if (!f)
		return nullptr;
	fseek(f, 0, SEEK_END);
	long n = ftell(f);
	fseek(f, 0, SEEK_SET);
	char* t = (char*)malloc(n + 1);
	fread(t, 1, n, f);
	t[n] = 0;
	fclose(f);
	return t;
}

int main()
{
	// the names are keydefs.h's
	CHECK(KeyFromName("UPARROW") == K_UPARROW && KeyFromName("downarrow") == K_DOWNARROW);
	CHECK(KeyFromName("LEFTARROW") == K_LEFTARROW && KeyFromName("RIGHTARROW") == K_RIGHTARROW);
	CHECK(KeyFromName("SPACE") == K_SPACE && KeyFromName("TAB") == K_TAB && KeyFromName("ENTER") == K_ENTER);
	CHECK(KeyFromName("BACKSPACE") == K_BACKSPACE);
	CHECK(KeyFromName("SHIFT") == K_SHIFT && KeyFromName("CTRL") == K_CTRL && KeyFromName("ALT") == K_ALT);
	CHECK(KeyFromName("F1") == K_F1 && KeyFromName("F12") == K_F12 && KeyFromName("F7") == K_F7);
	CHECK(KeyFromName("INS") == K_INS && KeyFromName("DEL") == K_DEL && KeyFromName("HOME") == K_HOME && KeyFromName("END") == K_END);
	CHECK(KeyFromName("PGUP") == K_PGUP && KeyFromName("PGDN") == K_PGDN);
	CHECK(KeyFromName("MOUSE1") == K_MOUSE1 && KeyFromName("MOUSE2") == K_MOUSE2 && KeyFromName("MOUSE3") == K_MOUSE3);
	CHECK(KeyFromName("MOUSE4") == K_MOUSE4 && KeyFromName("MOUSE5") == K_MOUSE5);
	CHECK(KeyFromName("MWHEELUP") == K_MWHEELUP && KeyFromName("MWHEELDOWN") == K_MWHEELDOWN);
	CHECK(KeyFromName("a") == 'a' && KeyFromName("A") == 'a' && KeyFromName("z") == 'z' && KeyFromName("5") == '5');
	CHECK(KeyFromName("ESCAPE") == -1 && KeyFromName("`") == -1 && KeyFromName("~") == -1 && KeyFromName("nonsense") == -1);
	CHECK(KeyFromName("") == -1 && KeyFromName(nullptr) == -1);

	// a bind line
	int key;
	char cmd[CMD_LEN];
	CHECK(ParseLine("\"UPARROW\" \"+forward\"", key, cmd, CMD_LEN) && key == K_UPARROW && strcmp(cmd, "+forward") == 0);
	CHECK(ParseLine("  \"l\"   \"impulse 100\"   // lights\r\n", key, cmd, CMD_LEN) && key == 'l' && strcmp(cmd, "impulse 100") == 0);
	CHECK(ParseLine("bind \"a\" \"x\"", key, cmd, CMD_LEN) == false);       // a config.cfg line with `bind` is not this file's
	CHECK(ParseLine("// \"a\" \"gearup\"", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("", key, cmd, CMD_LEN) == false && ParseLine("\r", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"ESCAPE\" \"quit\"", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"`\" \"quit\"", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"a\" \"quit; quit\"", key, cmd, CMD_LEN) == false);   // one command to a key
	CHECK(ParseLine("\"a\" \"unterminated", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"a\"", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"a\" \"b\" \"c\"", key, cmd, CMD_LEN) == false);
	CHECK(ParseLine("\"nokey\" \"b\"", key, cmd, CMD_LEN) == false);

	// a file: a later line wins, comments and junk go
	static Keymap m;
	CHECK(m.Parse("// head\n\"w\" \"+forward\"\r\n\"w\" \"+back\"\njunk\n\"MWHEELUP\" \"h9_gearup\"\n") == 2);
	CHECK(m.Find('w') >= 0 && strcmp(m.entries[m.Find('w')].cmd, "+back") == 0);
	CHECK(m.Parse(nullptr) == 0);

	m.Parse("\"UPARROW\" \"+forward\"\n\"SPACE\" \"+jump\"\n\"c\" \"h9_rallycam\"\n\"MWHEELUP\" \"h9_gearup\"\n");
	// a + command: down, a repeat, up
	CHECK(Is(m.Event(true, true, K_UPARROW), true, "+forward 128"));
	CHECK(Is(m.Event(true, true, K_UPARROW), true, nullptr)); // repeat: taken, nothing run
	CHECK(Is(m.Event(true, false, K_UPARROW), true, "-forward 128"));
	CHECK(Is(m.Event(true, false, K_UPARROW), false, nullptr)); // an up with no down is the engine's
	// a plain command: on the down only
	CHECK(Is(m.Event(true, true, 'c'), true, "h9_rallycam"));
	CHECK(Is(m.Event(true, true, 'c'), true, nullptr));
	CHECK(Is(m.Event(true, false, 'c'), true, nullptr));
	CHECK(Is(m.Event(true, true, 'c'), true, "h9_rallycam")); // and again
	m.Event(true, false, 'c');
	// the wheel comes as a down and an up
	CHECK(Is(m.Event(true, true, K_MWHEELUP), true, "h9_gearup"));
	CHECK(Is(m.Event(true, false, K_MWHEELUP), true, nullptr));
	// a key not listed, in the mode or out of it: the player's
	CHECK(Is(m.Event(true, true, 'q'), false, nullptr));
	CHECK(Is(m.Event(true, false, 'q'), false, nullptr));
	// outside the mode (or the console up): nothing is taken
	CHECK(Is(m.Event(false, true, K_UPARROW), false, nullptr));
	CHECK(Is(m.Event(false, true, 'c'), false, nullptr));
	// never ESCAPE or the console keys, even from a map that lists them
	m.count = 0;
	m.entries[m.count].key = K_ESCAPE;
	strcpy(m.entries[m.count++].cmd, "quit");
	m.entries[m.count].key = '`';
	strcpy(m.entries[m.count++].cmd, "quit");
	m.entries[m.count].key = '~';
	strcpy(m.entries[m.count++].cmd, "quit");
	CHECK(Is(m.Event(true, true, K_ESCAPE), false, nullptr));
	CHECK(Is(m.Event(true, true, '`'), false, nullptr));
	CHECK(Is(m.Event(true, true, '~'), false, nullptr));
	CHECK(Is(m.Event(true, true, 999), false, nullptr) && Is(m.Event(true, true, -1), false, nullptr));

	// held when the mode ends: the up still releases, and a release-all lets go of every + command and of nothing else
	m.Parse("\"UPARROW\" \"+forward\"\n\"SPACE\" \"+jump\"\n\"c\" \"h9_rallycam\"\n\"LEFTARROW\" \"+left\"\n");
	m.Event(true, true, K_UPARROW);
	m.Event(true, true, K_SPACE);
	m.Event(true, true, 'c');
	CHECK(Is(m.Event(false, false, K_SPACE), true, "-jump 32")); // up after the mode ended (active false)
	char line[96];
	CHECK(m.ReleaseNext(line, sizeof(line)) && strcmp(line, "-forward 128") == 0);
	CHECK(!m.ReleaseNext(line, sizeof(line))); // 'c' held but a plain command: nothing to release
	CHECK(Is(m.Event(true, false, K_UPARROW), false, nullptr)); // its real up comes later: the engine's, nothing doubled
	CHECK(Is(m.Event(true, true, K_LEFTARROW), true, "+left 130"));
	m.Parse("\"UPARROW\" \"+forward\"\n"); // the file swapped while held: the old line is let go of first by the caller
	CHECK(!m.ReleaseNext(line, sizeof(line))); // LEFTARROW is held and no longer in the file: nothing to name (the caller releases before it swaps)

	// the shipped files
	const char* files[2] = {"rally.txt", "rally_wasd.txt"};
	for (int i = 0; i < 2; i++)
	{
		char* t = ReadFile(files[i]);
		CHECK(t != nullptr);
		if (!t)
			continue;
		Keymap f;
		const int n = f.Parse(t);
		CHECK(n >= 15);
		// every command is one that exists in the game; a + command's - twin is the engine's
		static const char* const ok[] = {"+forward", "+back", "+left", "+right", "+jump", "+moveleft", "+moveright", "+attack2", "+reload",
			"h9_gearup", "h9_geardown", "h9_rallycam", "h9_rallycam_zoom", "impulse 100", "+h9_camdistance", "selectcar"};
		for (int e = 0; e < f.count; e++)
		{
			bool known = false;
			for (const char* o : ok)
				known = known || strcmp(o, f.entries[e].cmd) == 0;
			if (!known)
				printf("unknown command in %s: %s\n", files[i], f.entries[e].cmd);
			CHECK(known);
		}
		CHECK(f.Find(K_ESCAPE) < 0 && f.Find('`') < 0);
		free(t);
	}
	{
		char* t = ReadFile("rally.txt");
		Keymap f;
		if (t)
			f.Parse(t);
		CHECK(f.Find(K_UPARROW) >= 0 && strcmp(f.entries[f.Find(K_UPARROW)].cmd, "+forward") == 0);
		CHECK(f.Find('a') >= 0 && strcmp(f.entries[f.Find('a')].cmd, "h9_gearup") == 0);
		CHECK(f.Find('i') >= 0); // +h9_camdistance, HL Rally's i
		free(t);
		t = ReadFile("rally_wasd.txt");
		Keymap w;
		if (t)
			w.Parse(t);
		CHECK(w.Find('w') >= 0 && strcmp(w.entries[w.Find('w')].cmd, "+forward") == 0);
		CHECK(w.Find('a') >= 0 && strcmp(w.entries[w.Find('a')].cmd, "+moveleft") == 0);
		CHECK(w.Find('r') >= 0 && strcmp(w.entries[w.Find('r')].cmd, "+reload") == 0);
		free(t);
	}

	if (g_failed == 0)
		printf("PASS: keymap_test: %d checks\n", g_checked);
	else
		printf("FAIL: keymap_test: %d of %d checks failed\n", g_failed, g_checked);
	return g_failed == 0 ? 0 : 1;
}
