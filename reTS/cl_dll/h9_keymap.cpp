// H9 per-gamemode key layouts on the client. See h9_keymap.h; the logic is h9_keymap_calc.h.
#include "hud.h"
#include "cl_util.h"
#include "h9_keymap.h"
#include "h9_rallycar.h"
#include "h9_keymap_calc.h"

#include <stdio.h>
#include <string.h>

extern bool g_bTSKeyBound; // input.cpp: the nine + commands press only from a key bound to them

namespace
{
// The modes that have a layout. Only rally now; a new mode is a line here, its cvar, and its test of "is it on".
struct Mode
{
	const char* name;       // cl_h9_keys_<name> names the file
	const char* cvarName;
	const char* defFile;
	bool (*on)();
	cvar_t* cvar;
	h9keys::Keymap map;
	char loaded[64];        // the file name the map was read from ("" none)
};

Mode s_modes[] = {
	// only while he drives: dead, joining or spectating, the keys are his own (TS respawns on FIRE, which the keymap takes for the brake)
	{"rally", "cl_h9_keys_rally", "rally", H9RallyCam_LocalIsCar, nullptr, {}, ""},
};
const int kModes = (int)(sizeof(s_modes) / sizeof(s_modes[0]));

void Send(const char* line)
{
	char buf[128];
	snprintf(buf, sizeof(buf), "%s\n", line);
	gEngfuncs.pfnClientCmd(buf);
}

void ReleaseAll(Mode& m)
{
	char line[96];
	while (m.map.ReleaseNext(line, sizeof(line)))
		Send(line);
}

void Load(Mode& m)
{
	ReleaseAll(m); // before the entries change: a held key's "-cmd" comes from the old ones
	m.map.count = 0;
	const char* name = m.cvar != nullptr ? m.cvar->string : "";
	snprintf(m.loaded, sizeof(m.loaded), "%s", name != nullptr ? name : ""); // what was asked for, so a bad name is not asked again every frame
	if (name == nullptr || name[0] == '\0')
		return;
	// the name is a file name only: no folder, no dots
	for (const char* c = name; *c; c++)
	{
		if (*c == '/' || *c == '\\' || *c == '.' || *c == ':')
			return;
	}
	char path[96];
	snprintf(path, sizeof(path), "h9/keys/%s.txt", name);
	int len = 0;
	byte* data = gEngfuncs.COM_LoadFile(path, 5, &len);
	if (!data)
		return;
	char* text = new char[len + 1];
	memcpy(text, data, len);
	text[len] = '\0';
	gEngfuncs.COM_FreeFile(data);
	const int n = m.map.Parse(text);
	delete[] text;
	gEngfuncs.Con_DPrintf("h9 keys: %s: %d keys from %s\n", m.name, n, path);
}

bool Active(const Mode& m)
{
	// the console, or anything else that has the keys, is not ours
	return m.on() && 0 == gEngfuncs.Con_IsVisible();
}
} // namespace

void H9Keys_Init()
{
	for (int i = 0; i < kModes; i++)
		s_modes[i].cvar = CVAR_CREATE(s_modes[i].cvarName, s_modes[i].defFile, FCVAR_ARCHIVE);
}

void H9Keys_VidInit()
{
	for (int i = 0; i < kModes; i++)
		Load(s_modes[i]);
}

void H9Keys_Frame()
{
	for (int i = 0; i < kModes; i++)
	{
		Mode& m = s_modes[i];
		// the cvar changed: the file is read again
		if (m.cvar != nullptr && strcmp(m.cvar->string, m.loaded) != 0)
			Load(m);
		// the mode ended (or the console came up) with a key held: let go
		if (!Active(m))
			ReleaseAll(m);
	}
}

bool H9Keys_Event(int down, int keynum)
{
	for (int i = 0; i < kModes; i++)
	{
		Mode& m = s_modes[i];
		if (m.map.count == 0)
			continue;
		const h9keys::Action a = m.map.Event(Active(m), 0 != down, keynum);
		if (a.run)
		{
			// a + command from a key we took: it passes the gate as a bound key's does (the gate is cleared at the end of HUD_Frame)
			if (a.line[0] == '+')
				g_bTSKeyBound = true;
			Send(a.line);
		}
		if (a.swallow)
			return true;
	}
	return false;
}
