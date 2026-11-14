// H9 per-gamemode key layouts, the logic alone (no engine calls; tested by tests/keymap_test.cpp). A keymap is a text file of lines
//   "KEY" "command"
// written as a bind line of config.cfg is; `//` starts a comment. While a mode's keymap is on, a key it lists runs that file's command
// instead of the player's own bind; a key it does not list is left to the player's binds. Nothing here writes a bind.
//
// Key names are the engine's (keydefs.h numbers): a..z, 0..9, SPACE, TAB, ENTER, BACKSPACE, SHIFT, CTRL, ALT, UPARROW, DOWNARROW, LEFTARROW,
// RIGHTARROW, F1..F12, INS, DEL, HOME, END, PGUP, PGDN, MOUSE1..MOUSE5, MWHEELUP, MWHEELDOWN. ESCAPE and the console keys (` and ~) are
// never remapped: a line naming them is dropped.
#pragma once

#include <stdio.h>
#include <string.h>

namespace h9keys
{
const int MAX_ENTRIES = 64;
const int CMD_LEN = 64;

struct NameKey
{
	const char* name;
	int key;
};

// The numbers are keydefs.h's (public/keydefs.h); tests/keymap_test.cpp holds them to it.
static const NameKey kNames[] = {
	{"TAB", 9}, {"ENTER", 13}, {"SPACE", 32}, {"BACKSPACE", 127},
	{"UPARROW", 128}, {"DOWNARROW", 129}, {"LEFTARROW", 130}, {"RIGHTARROW", 131},
	{"ALT", 132}, {"CTRL", 133}, {"SHIFT", 134},
	{"F1", 135}, {"F2", 136}, {"F3", 137}, {"F4", 138}, {"F5", 139}, {"F6", 140},
	{"F7", 141}, {"F8", 142}, {"F9", 143}, {"F10", 144}, {"F11", 145}, {"F12", 146},
	{"INS", 147}, {"DEL", 148}, {"PGDN", 149}, {"PGUP", 150}, {"HOME", 151}, {"END", 152},
	{"MOUSE1", 241}, {"MOUSE2", 242}, {"MOUSE3", 243}, {"MOUSE4", 244}, {"MOUSE5", 245},
	{"MWHEELDOWN", 239}, {"MWHEELUP", 240},
};

static inline char Up(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : c; }

static inline bool SameName(const char* a, const char* b)
{
	while (*a && *b)
	{
		if (Up(*a++) != Up(*b++))
			return false;
	}
	return *a == *b;
}

// The engine's number for a key name, -1 if unknown. Single letters and digits are their lower-case ASCII, as the engine passes them.
static inline int KeyFromName(const char* name)
{
	if (name == nullptr || name[0] == '\0')
		return -1;
	if (name[1] == '\0')
	{
		const char c = name[0];
		if (c >= 'a' && c <= 'z')
			return c;
		if (c >= 'A' && c <= 'Z')
			return c - 'A' + 'a';
		if (c >= '0' && c <= '9')
			return c;
		return -1; // ` ~ and the punctuation: not offered (the console key must stay the console's)
	}
	for (const NameKey& n : kNames)
	{
		if (SameName(n.name, name))
			return n.key;
	}
	return -1;
}

// One line to a key and a command. false: a blank line, a comment, or a line that is not `"KEY" "command"` with a key this file may remap.
static inline bool ParseLine(const char* line, int& key, char* cmd, int cmdSize)
{
	const char* p = line;
	char word[2][CMD_LEN];
	for (int w = 0; w < 2; w++)
	{
		while (*p == ' ' || *p == '\t')
			p++;
		if (*p == '\0' || *p == '\r' || *p == '\n')
			return false;
		if (p[0] == '/' && p[1] == '/')
			return false;
		int n = 0;
		if (*p == '"')
		{
			p++;
			while (*p != '"' && *p != '\0' && *p != '\r' && *p != '\n')
			{
				if (n < CMD_LEN - 1)
					word[w][n++] = *p;
				p++;
			}
			if (*p != '"')
				return false; // unterminated
			p++;
		}
		else
		{
			while (*p != ' ' && *p != '\t' && *p != '\0' && *p != '\r' && *p != '\n')
			{
				if (n < CMD_LEN - 1)
					word[w][n++] = *p;
				p++;
			}
		}
		word[w][n] = '\0';
	}
	// what follows the command may only be a comment
	while (*p == ' ' || *p == '\t')
		p++;
	if (!(*p == '\0' || *p == '\r' || *p == '\n' || (p[0] == '/' && p[1] == '/')))
		return false;
	if (word[1][0] == '\0')
		return false;
	const int k = KeyFromName(word[0]);
	if (k < 0)
		return false;
	if ((int)strlen(word[1]) >= cmdSize)
		return false;
	// one command, so that a press is one thing
	if (strchr(word[1], ';') != nullptr)
		return false;
	key = k;
	strcpy(cmd, word[1]);
	return true;
}

struct Entry
{
	int key;
	char cmd[CMD_LEN];
};

// What a key event comes to: swallow it (the engine does not run the player's bind) or leave it to the engine, and the line to run.
struct Action
{
	bool swallow = false;
	bool run = false; // `line` is a command to run
	char line[CMD_LEN + 16] = "";
};

struct Keymap
{
	Entry entries[MAX_ENTRIES];
	int count = 0;
	bool held[256] = {}; // a key we ran a command for and have not yet seen released

	int Find(int key) const
	{
		for (int i = 0; i < count; i++)
		{
			if (entries[i].key == key)
				return i;
		}
		return -1;
	}

	// A whole file's text. A later line for a key replaces an earlier one. Call ReleaseNext until it is false first when held keys may exist.
	int Parse(const char* text)
	{
		count = 0;
		if (text == nullptr)
			return 0;
		const char* p = text;
		while (*p)
		{
			char line[256];
			int n = 0;
			while (*p && *p != '\n')
			{
				if (n < (int)sizeof(line) - 1)
					line[n++] = *p;
				p++;
			}
			if (*p == '\n')
				p++;
			line[n] = '\0';
			int key;
			char cmd[CMD_LEN];
			if (!ParseLine(line, key, cmd, CMD_LEN))
				continue;
			int at = Find(key);
			if (at < 0)
			{
				if (count >= MAX_ENTRIES)
					continue;
				at = count++;
			}
			entries[at].key = key;
			strcpy(entries[at].cmd, cmd);
		}
		return count;
	}

	// A key event; `active`: the mode is on and nothing (console, menu, chat) has the keys. `keynum` as the engine passes it.
	// A + command: down "+cmd keynum", up "-cmd keynum" (the argument the engine adds to a bind's, which KeyDown and KeyUp read); a repeat of
	// a key still down is swallowed and runs nothing. Any other command runs on the first down; its up is swallowed. A key not listed, and
	// any key while inactive, is left alone, except the up of a key we hold: that releases, whatever else has changed meanwhile.
	Action Event(bool active, bool down, int keynum)
	{
		Action a;
		if (keynum < 0 || keynum > 255)
			return a;
		if (!down)
		{
			if (!held[keynum])
				return a;
			held[keynum] = false;
			const int at = Find(keynum);
			if (at >= 0 && entries[at].cmd[0] == '+')
			{
				a.run = true;
				snprintf(a.line, sizeof(a.line), "-%s %d", entries[at].cmd + 1, keynum);
			}
			a.swallow = true;
			return a;
		}
		if (!active || keynum == 27 || keynum == '`' || keynum == '~')
			return a;
		const int at = Find(keynum);
		if (at < 0)
			return a;
		a.swallow = true;
		if (held[keynum])
			return a; // a repeat
		held[keynum] = true;
		a.run = true;
		if (entries[at].cmd[0] == '+')
			snprintf(a.line, sizeof(a.line), "%s %d", entries[at].cmd, keynum);
		else
			snprintf(a.line, sizeof(a.line), "%s", entries[at].cmd);
		return a;
	}

	// The next held key to let go (the mode ended, the map changed, the file is to be swapped): its "-cmd keynum" line; false when none is left.
	bool ReleaseNext(char* line, int size)
	{
		for (int k = 0; k < 256; k++)
		{
			if (!held[k])
				continue;
			held[k] = false;
			const int at = Find(k);
			if (at >= 0 && entries[at].cmd[0] == '+')
			{
				snprintf(line, size, "-%s %d", entries[at].cmd + 1, k);
				return true;
			}
		}
		return false;
	}
};
} // namespace h9keys
