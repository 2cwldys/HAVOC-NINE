// ---- H9 ARP inventory: the list of the item pictures ----------------------------------------------------------------------------
// sprites/h9_arpicons.txt names the frames of sprites/h9_arpicons.spr, a line for each: an item's name, a bar and the frame number
// ("Flashlight|88"). A line that starts with # or / and a line with no bar are not names. The engine part (h9_arpinv.cpp) reads the file and
// the sheet; this is the reading of the text and the look-up, with no engine in it, so that a test reads the very file the game ships
// (tests\test_arpinv.cpp, tests\check_arpicons.py).
#pragma once

#include "h9_arpinv_model.h"

#include <stdlib.h>
#include <string.h>

namespace arpinv
{
const int ICON_NAMES_MAX = 256; // names the client keeps

struct IconList
{
	struct Entry
	{
		char name[NAME_LEN];
		int frame;
	};
	Entry entries[ICON_NAMES_MAX];
	int count;   // names kept
	int refused; // names that were read and not kept: the list was full, or the frame is not one of the sheet's

	IconList() { Clear(); }

	void Clear()
	{
		count = 0;
		refused = 0;
	}

	// Reads the text of the file, ended by a 0. frames is how many frames the sheet has; a name whose frame is not one of them is refused, so
	// that its tile is a monogram and not the last frame of the sheet. -1 keeps every name.
	void Parse(const char* text, int frames = -1)
	{
		Clear();
		const char* p = text ? text : "";
		while (*p)
		{
			char line[96];
			int l = 0;
			while (*p && *p != '\n' && *p != '\r')
			{
				if (l < (int)sizeof(line) - 1)
					line[l++] = *p;
				p++;
			}
			line[l] = 0;
			while (*p == '\n' || *p == '\r')
				p++;
			char* bar = strchr(line, '|');
			if (!bar || line[0] == '/' || line[0] == '#')
				continue;
			*bar = 0;
			const int frame = atoi(bar + 1);
			if (count >= ICON_NAMES_MAX || frame < 0 || (frames >= 0 && frame >= frames))
			{
				refused++;
				continue;
			}
			Entry& e = entries[count++];
			strncpy(e.name, line, NAME_LEN - 1);
			e.name[NAME_LEN - 1] = 0;
			e.frame = frame;
		}
	}

	// The frame of an item's picture, -1 for none. The name is compared exactly, case and all.
	int Find(const char* name) const
	{
		if (!name)
			return -1;
		for (int i = 0; i < count; i++)
		{
			if (0 == strcmp(entries[i].name, name))
				return entries[i].frame;
		}
		return -1;
	}
};
} // namespace arpinv
// ---- end H9 ARP inventory pictures ------------------------------------------------------------------------------------------------
